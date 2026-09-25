/**
 * DefaultContextEngine — 默认上下文引擎
 *
 * Harness 层的默认实现，整合所有组件：
 * - MessageSelector：消息选择
 * - Compressor：压缩（截断 + LLM 摘要）
 * - BudgetAllocator：预算分配
 * - TokenEstimator：Token 估算
 *
 * 特性：
 * - 四区域划分（头部保护 + 中间可压缩 + 尾部保护）
 * - 边界对齐（不拆分 tool_call/tool_result 对）
 * - 工具结果预处理（清除旧工具输出）
 * - 迭代式摘要（传入上次摘要，更新而非重建）
 * - 实际 token 数回写
 */

import type { Message } from '../../core/types.js';
import { getTextContent } from '../../core/types.js';
import type { LLMMessage, LLMToolDefinition } from '../../core/interfaces/model-provider.js';
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleParams,
  AssembleResult,
  IngestParams,
  CompactParams,
  CompactResult,
  AfterTurnParams,
  TokenEstimator,
  SummarizeFunction,
  MessageSelector,
  Compressor,
  BudgetAllocator,
  ContextEmitFn,
  ContextCompactSnapshot,
} from './types.js';
import { HeuristicTokenEstimator, estimateLLMMessages } from './token-estimator.js';
import { DefaultMessageSelector } from './message-selector.js';
import { HybridCompressor } from './hybrid-compressor.js';
import { DefaultBudgetAllocator } from './budget-allocator.js';
import { SmartRouter } from './smart-router.js';
import type { SmartRouterConfig } from './smart-router.js';
import { compactStateKey } from './compact-key.js';
import { createCompactEngine } from '../capabilities/compact/index.js';
import type { CompactEngine } from '../capabilities/compact/index.js';

// ── 配置 ──

export interface DefaultContextEngineConfig {
  /** 消息选择策略 */
  messageSelector?: MessageSelector;
  /** 压缩策略 */
  compressor?: Compressor;
  /** 预算分配策略 */
  budgetAllocator?: BudgetAllocator;
  /** Token 估算器 */
  tokenEstimator?: TokenEstimator;
  /** 智能路由器配置 */
  router?: SmartRouterConfig;
  /** 头部保护消息数（默认 3） */
  protectFirstN?: number;
  /** 尾部保护消息数（默认 20） */
  protectLastN?: number;
  /** 触发压缩的阈值比例（默认 0.5） */
  compactThreshold?: number;
  /**
   * 主动摘要阈值：消息 token / messagesBudget 超过该比例时，
   * 在窗口硬溢出之前先做 LLM 摘要（缓解长会话失忆）。
   * 默认 0.6；设为 0 关闭主动摘要。
   */
  proactiveCompactRatio?: number;
  /**
   * 主动 LLM 摘要冷却（ms）。冷却期内优先缓存重建，避免单 turn 双摘要。
   * 默认 30_000；0 表示不冷却。
   */
  proactiveCooldownMs?: number;
  /** 公用能力 CompactEngine（缺省自动创建；算法委托，E4 状态仍在本引擎） */
  compactEngine?: CompactEngine;
}

// ── 内部状态 ──

interface CompactState {
  /** 上次摘要正文（用于迭代更新，不是 dropped 描述） */
  previousSummary?: string;
  /** 上次实际 token 数（来自 LLM usage） */
  lastActualTokens?: number;
  /** 上次估算 token 数 */
  lastEstimatedTokens?: number;
  /** 上次 usage 对应的消息数量快照（用于增量估算） */
  lastUsageMessageCount?: number;
  /** 估算校准比率 = actual / estimated（用于修正后续估算） */
  calibrationRatio?: number;
  /** 上次主动摘要时的全量消息条数（用于判断是否需要再摘要） */
  lastProactiveMessageCount?: number;
  /** 上次主动摘要后的视图 token 估算 */
  lastProactiveTokens?: number;
  /** 上次主动 LLM 摘要时间戳（冷却） */
  lastProactiveLlmAt?: number;
}

// ── 引擎实现 ──

/** 摘要正文包装：确保带 [Conversation Summary] 标记，便于 extract / 调试 */
function wrapContextSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.includes('[Conversation Summary]')) return trimmed;
  return `[Conversation Summary]\n\n${trimmed}`;
}

/** 供调用方/测试引用 */
export { wrapContextSummary };

export class DefaultContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: 'default',
    name: 'Default Context Engine',
    ownsCompaction: true,
  };

  private config: Required<Omit<DefaultContextEngineConfig, 'compactEngine'>> & {
    compactEngine: CompactEngine;
  };
  private router: SmartRouter;
  private states: Map<string, CompactState> = new Map();

  constructor(config?: DefaultContextEngineConfig) {
    const tokenEstimator = config?.tokenEstimator ?? new HeuristicTokenEstimator();

    this.config = {
      messageSelector: config?.messageSelector ?? new DefaultMessageSelector(),
      compressor: config?.compressor ?? new HybridCompressor(),
      budgetAllocator: config?.budgetAllocator ?? new DefaultBudgetAllocator(),
      tokenEstimator,
      router: config?.router ?? {},
      protectFirstN: config?.protectFirstN ?? 3,
      protectLastN: config?.protectLastN ?? 20,
      compactThreshold: config?.compactThreshold ?? 0.5,
      proactiveCompactRatio: config?.proactiveCompactRatio ?? 0.6,
      proactiveCooldownMs: config?.proactiveCooldownMs ?? 30_000,
      compactEngine:
        config?.compactEngine ??
        createCompactEngine({
          defaultProtectHead: config?.protectFirstN ?? 3,
          defaultProtectTail: config?.protectLastN ?? 20,
          estimator: {
            estimateMessages: (m) => tokenEstimator.estimateMessages(m),
            estimateText: (t) => tokenEstimator.estimateText(t),
          },
        }),
    };

    this.router = new SmartRouter({
      ...this.config.router,
      tokenEstimator,
    });
  }

  /**
   * 组装上下文
   *
   * 核心方法。根据 token 预算，选择最有价值的信息组装成 LLM 上下文。
   *
   * 使用 SmartRouter 进行智能路由决策：
   * - fits: 不需要压缩
   * - truncate_tool_results_only: 只截断工具输出
   * - compact_only: 只做 LLM 摘要
   * - compact_then_truncate: 先 LLM 摘要，再截断
   */
  async assemble(params: AssembleParams): Promise<AssembleResult> {
    const {
      sessionId,
      agentId,
      messages,
      systemPrompt,
      tools,
      contextWindow,
      compactTargetTokens,
      signal,
      tokenEstimator,
      summarize,
      emit,
      loadCompactState,
    } = params;
    // E4：引擎内部 compact 状态键 = (sessionId, agentId)
    const stateKey = compactStateKey(sessionId, agentId);

    // 窗口未知且无显式 compactTargetTokens：跳过基于预算的自动压缩/截断
    const budgetCap = params.tokenBudget ?? contextWindow ?? compactTargetTokens;
    const windowKnown = contextWindow != null && contextWindow > 0;
    const targetKnown = compactTargetTokens != null && compactTargetTokens > 0;

    const estimator = tokenEstimator ?? this.config.tokenEstimator;

    // 0. 进程重启后从持久层恢复压缩状态（仅当内存态尚无摘要时）
    if (loadCompactState) {
      const existing = this.states.get(stateKey);
      if (!existing?.previousSummary) {
        const restored = await loadCompactState(sessionId);
        if (restored?.summary || restored?.lastProactiveMessageCount != null) {
          this.states.set(stateKey, {
            ...existing,
            previousSummary: restored.summary ?? existing?.previousSummary,
            lastProactiveMessageCount:
              restored.lastProactiveMessageCount ?? existing?.lastProactiveMessageCount,
            lastProactiveTokens: restored.lastProactiveTokens ?? existing?.lastProactiveTokens,
          });
        }
      }
    }

    // 未知窗口：无 token 预算 → 不 proactive、不按 budget 截消息
    // 已有结构压缩摘要时，用 head + summary + tail 视图
    if (!windowKnown && !targetKnown && budgetCap == null) {
      const view = this.buildStructuralView(sessionId, messages, emit, stateKey);
      const llmMessages = this.buildLlmMessages(view.messages, systemPrompt, tools);
      const rawEstimatedTokens = estimateLLMMessages(llmMessages);
      this.states.set(stateKey, {
        ...this.states.get(stateKey),
        lastEstimatedTokens: rawEstimatedTokens,
      });
      return {
        messages: llmMessages,
        estimatedTokens: this.calibrateTokens(sessionId, rawEstimatedTokens, stateKey),
        systemPrompt,
        droppedSummary: view.droppedSummary,
        summary: this.states.get(stateKey)?.previousSummary,
        compactState: this.buildCompactSnapshot(sessionId, stateKey),
      };
    }

    // 1. 计算可用预算（有窗口或 compactTargetTokens 时）
    const tokenBudgetForAlloc = budgetCap;
    const budget = this.config.budgetAllocator.allocate({
      tokenBudget: tokenBudgetForAlloc,
      contextWindow: windowKnown ? contextWindow : undefined,
      systemPromptTokens: estimator.estimateText(systemPrompt),
      toolTokens: estimator.estimateTools(tools),
    });

    // 1b. 主动摘要：仅在有预算时启用（基于窗口/显式 target 的自动压缩）
    const proactive = await this.applyProactiveCompact({
      sessionId,
      stateKey,
      messages,
      messagesBudget: budget.messagesBudget,
      summarize,
      estimator,
      emit,
    });
    const workingMessages = proactive.messages;
    const proactiveDroppedSummary = proactive.droppedSummary;

    // 2. 四区域消息选择（MessageSelector）
    const selection = this.config.messageSelector.select(
      workingMessages,
      {
        maxTokens: budget.messagesBudget,
        protectFirstN: this.config.protectFirstN,
        protectLastN: this.config.protectLastN,
      },
      estimator,
    );

    // 3. 如果没有溢出，不需要压缩
    if (selection.overflow.length === 0) {
      const llmMessages = this.buildLlmMessages(selection.kept, systemPrompt, tools);
      const rawEstimatedTokens = estimateLLMMessages(llmMessages);
      const estimatedTokens = this.calibrateTokens(sessionId, rawEstimatedTokens, stateKey);

      this.states.set(stateKey, {
        ...this.states.get(stateKey),
        lastEstimatedTokens: rawEstimatedTokens,
      });

      return {
        messages: llmMessages,
        estimatedTokens,
        systemPrompt,
        droppedSummary: proactiveDroppedSummary,
        summary: this.states.get(stateKey)?.previousSummary,
        compactState: this.buildCompactSnapshot(sessionId, stateKey),
      };
    }

    // 4. 有溢出：SmartRouter 决定压缩策略
    //    传入 messagesBudget=0，因为 MessageSelector 已确认这些消息是溢出部分
    //    SmartRouter 只负责决定压缩方式（truncate vs compact），不负责判断是否需要压缩
    const overflowTokens = estimator.estimateMessages(selection.overflow);
    const routing = this.router.evaluate(
      selection.overflow,
      0,
      !!summarize,
    );

    // 5. 压缩溢出消息
    const state = this.states.get(stateKey);
    const previousSummary = state?.previousSummary;

    let compressedOverflow: Message[];
    let droppedSummary: string | undefined;

    // 计算溢出部分的压缩目标：head + selectedMiddle + tail 已占的 token
    // selection.estimatedTokens = head + selectedMiddle + tail 的 token 数
    // 压缩后 overflow 应使总 token 在预算内
    const keptTokens = selection.estimatedTokens;
    const overflowTargetTokens = Math.max(500, budget.messagesBudget - keptTokens);
    const overflowStart = Date.now();
    const overflowTokensBefore = overflowTokens;
    emit?.({
      type: 'context.compact.start',
      sessionId,
      reason: 'overflow',
      tokensBefore: overflowTokensBefore,
    });

    try {
      switch (routing.route) {
        case 'truncate_tool_results_only': {
          const compressed = await this.config.compressor.compress({
            messages: selection.overflow,
            targetTokens: overflowTargetTokens,
            previousSummary,
            tokenEstimator: estimator,
          });
          compressedOverflow = compressed.result;
          droppedSummary = compressed.droppedSummary;
          break;
        }

        case 'compact_only':
        case 'compact_then_truncate': {
          const compressed = await this.config.compressor.compress({
            messages: selection.overflow,
            targetTokens: overflowTargetTokens,
            previousSummary,
            summarize,
            tokenEstimator: estimator,
          });
          compressedOverflow = compressed.result;
          droppedSummary = compressed.droppedSummary;
          break;
        }

        default: {
          // 兜底：直接截断
          compressedOverflow = selection.overflow.slice(-4);
          break;
        }
      }
    } catch (err) {
      emit?.({
        type: 'context.compact.error',
        sessionId,
        reason: 'overflow',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - overflowStart,
      });
      // 压缩失败：截断兜底，不中断本轮
      compressedOverflow = selection.overflow.slice(-4);
      droppedSummary = 'Context compact failed; fell back to truncation';
    }

    // 6. 重组：head + compressed overflow + tail
    //    kept = head + (部分 middle) + tail，tail 和 kept 有重叠
    //    head = kept 中去掉 tail 的部分（包含 head + 部分 middle）
    const head = selection.kept.length > selection.tail.length
      ? selection.kept.slice(0, selection.kept.length - selection.tail.length)
      : [];
    const reassembled = [...head, ...compressedOverflow, ...selection.tail];

    // 7. 更新状态
    const compressedTokens = estimator.estimateMessages(reassembled);
    emit?.({
      type: 'context.compact.end',
      sessionId,
      reason: 'overflow',
      tokensBefore: overflowTokensBefore,
      tokensAfter: compressedTokens,
      durationMs: Date.now() - overflowStart,
      cached: false,
    });
    const overflowState = this.states.get(stateKey);
    this.states.set(stateKey, {
      ...overflowState,
      // 存摘要正文（而非 dropped 描述），供下次迭代更新
      previousSummary: this.extractSummaryText(compressedOverflow) ?? overflowState?.previousSummary,
      lastEstimatedTokens: compressedTokens,
    });

    // 8. 构建 LLM 消息
    const llmMessages = this.buildLlmMessages(reassembled, systemPrompt, tools);
    const rawEstimatedTokens = estimateLLMMessages(llmMessages);
    const estimatedTokens = this.calibrateTokens(sessionId, rawEstimatedTokens, stateKey);

    return {
      messages: llmMessages,
      estimatedTokens,
      systemPrompt,
      droppedSummary: droppedSummary ?? proactiveDroppedSummary,
      summary: this.states.get(stateKey)?.previousSummary,
      compactState: this.buildCompactSnapshot(sessionId, stateKey),
    };
  }

  /** 从引擎内存态导出可持久化快照 */
  private buildCompactSnapshot(sessionId: string, stateKey?: string): ContextCompactSnapshot | undefined {
    const state = this.states.get(stateKey ?? sessionId);
    if (!state?.previousSummary && state?.lastProactiveMessageCount == null) {
      return undefined;
    }
    return {
      summary: state?.previousSummary,
      lastProactiveMessageCount: state?.lastProactiveMessageCount,
      lastProactiveTokens: state?.lastProactiveTokens,
    };
  }

  /**
   * 主动摘要：消息 token 超过 messagesBudget × ratio 时，在硬溢出前压缩
   *
   * 策略：
   * - 未超阈值：原样返回
   * - 超阈值且需要新摘要（无 previousSummary / 新增消息够多）：LLM 压缩中间段
   * - 超阈值但增量很小：用 previousSummary + head/tail 重建视图（零 LLM）
   */
  private async applyProactiveCompact(params: {
    sessionId: string;
    /** E4 engine state key; defaults to sessionId */
    stateKey?: string;
    messages: Message[];
    messagesBudget: number;
    summarize?: SummarizeFunction;
    estimator: TokenEstimator;
    emit?: ContextEmitFn;
  }): Promise<{ messages: Message[]; droppedSummary?: string }> {
    const { sessionId, messages, messagesBudget, summarize, estimator, emit } = params;
    const stateKey = params.stateKey ?? sessionId;
    const ratio = this.config.proactiveCompactRatio;

    if (!summarize || ratio <= 0 || messages.length === 0) {
      return { messages };
    }

    const currentTokens = estimator.estimateMessages(messages);
    const threshold = Math.floor(messagesBudget * ratio);
    if (currentTokens <= threshold) {
      return { messages };
    }

    const protectFirstN = this.config.protectFirstN;
    const protectLastN = this.config.protectLastN;
    if (messages.length <= protectFirstN + protectLastN) {
      return { messages };
    }

    const state = this.states.get(stateKey);
    const head = messages.slice(0, protectFirstN);
    const tail = messages.slice(-protectLastN);

    // 增量很小：直接用上次摘要重建视图，避免每轮打 LLM
    // 注意：只比「自上次摘要以来新增条数」，不要拿全量 token 和压缩后视图比
    const lastCount = state?.lastProactiveMessageCount;
    const newSinceLast = lastCount === undefined ? messages.length : messages.length - lastCount;
    const minNewForResummarize = Math.max(3, Math.floor(protectLastN * 0.25));
    const needNewSummary = !state?.previousSummary || newSinceLast >= minNewForResummarize;

    // 冷却：刚做过 LLM 摘要则优先缓存重建，降低单 turn 双摘要概率
    const cooldownMs = this.config.proactiveCooldownMs;
    const inCooldown =
      cooldownMs > 0 &&
      state?.lastProactiveLlmAt != null &&
      Date.now() - state.lastProactiveLlmAt < cooldownMs;

    if (state?.previousSummary && (!needNewSummary || inCooldown)) {
      // 摘要用 user 角色承载，避免中段 system 被严格网关拒绝
      const summaryMsg: Message = {
        role: 'user',
        content: wrapContextSummary(state.previousSummary),
        timestamp: Date.now(),
        metadata: { source: 'contextSummary' as const },
      };
      const reduced = [...head, summaryMsg, ...tail];
      const reducedTokens = estimator.estimateMessages(reduced);
      // 只更新视图 token，**不要**改 lastProactiveMessageCount：
      // 该字段表示「摘要覆盖到的全量条数」，只能在真正 LLM 摘要时推进。
      // 若缓存重建也改成 messages.length，每轮 +1 会永远凑不满再摘要阈值。
      this.states.set(stateKey, {
        ...state,
        lastProactiveTokens: reducedTokens,
        lastEstimatedTokens: reducedTokens,
      });
      // 缓存重建极快，仍发 start/end 以便 UI 状态机一致（cached=true）
      emit?.({
        type: 'context.compact.start',
        sessionId,
        reason: 'proactive',
        tokensBefore: currentTokens,
        threshold,
      });
      emit?.({
        type: 'context.compact.end',
        sessionId,
        reason: 'proactive',
        tokensBefore: currentTokens,
        tokensAfter: reducedTokens,
        durationMs: 0,
        cached: true,
      });
      return { messages: reduced };
    }

    // 需要新摘要：压缩 head/tail 之间的中间段（语义历史，不含 grounding）
    const middle = this.semanticHistory(
      messages.slice(protectFirstN, messages.length - protectLastN),
    );
    if (middle.length === 0) {
      return { messages };
    }

    const headTailTokens = estimator.estimateMessages(head) + estimator.estimateMessages(tail);
    const targetMiddleTokens = Math.max(
      200,
      Math.floor(threshold * 0.55) - headTailTokens,
    );

    const proactiveStart = Date.now();
    emit?.({
      type: 'context.compact.start',
      sessionId,
      reason: 'proactive',
      tokensBefore: currentTokens,
      threshold,
    });

    let compressed: Awaited<ReturnType<Compressor['compress']>>;
    try {
      compressed = await this.config.compressor.compress({
        messages: middle,
        targetTokens: targetMiddleTokens,
        previousSummary: state?.previousSummary,
        summarize,
        tokenEstimator: estimator,
      });
    } catch (err) {
      emit?.({
        type: 'context.compact.error',
        sessionId,
        reason: 'proactive',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - proactiveStart,
      });
      // 主动摘要失败：不改视图，交给后续硬溢出路径处理
      return { messages };
    }

    const reduced = [...head, ...compressed.result, ...tail];
    const reducedTokens = estimator.estimateMessages(reduced);
    const actualSummary =
      this.extractSummaryText(compressed.result) ?? state?.previousSummary;

    this.states.set(stateKey, {
      ...state,
      previousSummary: actualSummary,
      lastEstimatedTokens: reducedTokens,
      lastProactiveMessageCount: messages.length,
      lastProactiveTokens: reducedTokens,
      lastProactiveLlmAt: Date.now(),
    });

    emit?.({
      type: 'context.compact.end',
      sessionId,
      reason: 'proactive',
      tokensBefore: currentTokens,
      tokensAfter: reducedTokens,
      durationMs: Date.now() - proactiveStart,
      cached: false,
    });

    return {
      messages: reduced,
      droppedSummary: compressed.droppedSummary ?? 'Older turns proactively summarized',
    };
  }

  /** 从压缩结果中提取摘要正文（contextSummary 标记或 [Conversation Summary] 前缀） */
  private extractSummaryText(compressed: Message[]): string | undefined {
    for (const m of compressed) {
      if (m.metadata?.source === 'contextSummary' && typeof m.content === 'string' && m.content.trim()) {
        return m.content;
      }
    }
    for (const m of compressed) {
      if (typeof m.content === 'string' && m.content.includes('[Conversation Summary]')) {
        return m.content;
      }
    }
    return undefined;
  }

  /**
   * 压缩/摘要的语义输入：丢掉托管 system 与 knowledgeGrounding
   * （grounding 每轮现算，不进 previousSummary）
   */
  private semanticHistory(messages: Message[]): Message[] {
    return messages.filter((m) => {
      if (m.role === 'system' && m.metadata?.source === 'systemPrompt') return false;
      if (m.metadata?.source === 'knowledgeGrounding') return false;
      return true;
    });
  }

  /**
   * 结构视图：有 previousSummary 时 head + summary + tail；否则原样
   * 用于 contextWindow 未知时的 assemble / 手动压缩后的回放
   */
  private buildStructuralView(
    sessionId: string,
    messages: Message[],
    emit?: ContextEmitFn,
    stateKey?: string,
  ): { messages: Message[]; droppedSummary?: string } {
    const state = this.states.get(stateKey ?? sessionId);
    const summary = state?.previousSummary;
    if (!summary || messages.length === 0) {
      return { messages };
    }
    const protectFirstN = this.config.protectFirstN;
    const protectLastN = this.config.protectLastN;
    if (messages.length <= protectFirstN + protectLastN) {
      return { messages };
    }
    const head = messages.slice(0, protectFirstN);
    const tail = messages.slice(-protectLastN);
    const summaryMsg: Message = {
      role: 'user',
      content: wrapContextSummary(summary),
      timestamp: Date.now(),
      metadata: { source: 'contextSummary' as const },
    };
    emit?.({
      type: 'context.compact.start',
      sessionId,
      reason: 'proactive',
    });
    emit?.({
      type: 'context.compact.end',
      sessionId,
      reason: 'proactive',
      tokensBefore: 0,
      tokensAfter: 0,
      cached: true,
    });
    return {
      messages: [...head, summaryMsg, ...tail],
      droppedSummary: 'Structural compact view (contextWindow unknown)',
    };
  }

  /**
   * 结构压缩：头尾保护 + 中间段摘要（不依赖 contextWindow）
   * 算法委托 capabilities/compact；本引擎只维护 E4 状态。
   */
  private async structuralCompact(params: {
    sessionId: string;
    stateKey?: string;
    messages: Message[];
    summarize?: SummarizeFunction;
    estimator: TokenEstimator;
    compactTargetTokens?: number;
  }): Promise<{ summary: string; tokensBefore: number; tokensAfter: number }> {
    const { sessionId, messages, summarize, estimator } = params;
    const stateKey = params.stateKey ?? sessionId;
    const protectFirstN = this.config.protectFirstN;
    const protectLastN = this.config.protectLastN;
    const tokensBefore = estimator.estimateMessages(messages);
    const state = this.states.get(stateKey);

    if (messages.length <= protectFirstN + protectLastN) {
      return {
        summary: state?.previousSummary ?? '',
        tokensBefore,
        tokensAfter: tokensBefore,
      };
    }

    const outcome = await this.config.compactEngine.compactMessages(
      this.semanticHistory(messages),
      {
        protectHead: protectFirstN,
        protectTail: protectLastN,
        targetTokens: params.compactTargetTokens,
        mode: 'structure_only',
        previousSummary: state?.previousSummary,
        summarizeFn: summarize,
        estimator,
        maxSummaryTokens: params.compactTargetTokens
          ? Math.max(200, Math.floor(params.compactTargetTokens * 0.3))
          : undefined,
        onSummarizeFail: 'truncate',
      },
    );

    const summary =
      outcome.summary ??
      state?.previousSummary ??
      `[Structural compact] dropped messages (contextWindow unknown)`;
    const tokensAfter = outcome.tokensAfter ?? tokensBefore;

    this.states.set(stateKey, {
      ...state,
      previousSummary: summary,
      lastProactiveMessageCount: messages.length,
      lastProactiveTokens: tokensAfter,
      lastEstimatedTokens: tokensAfter,
      lastProactiveLlmAt: summarize ? Date.now() : state?.lastProactiveLlmAt,
    });

    return { summary, tokensBefore, tokensAfter };
  }

  /**
   * 压缩存储
   *
   * - force / 无 tokenBudget：可走结构压缩（compactStructural）
   * - 有 tokenBudget 且非 force：低于阈值跳过
   * - 窗口未知且非 force、无 target：跳过自动压缩
   */
  async compact(params: CompactParams): Promise<CompactResult> {
    const {
      sessionId,
      agentId,
      tokenBudget,
      compactTargetTokens,
      force,
      currentTokenCount,
    } = params;
    const stateKey = compactStateKey(sessionId, agentId);

    const state = this.states.get(stateKey);
    if (!state) {
      return {
        ok: true,
        compacted: false,
        reason: 'No state found for session',
        tokensBefore: 0,
      };
    }

    const tokensBefore =
      currentTokenCount ?? state.lastEstimatedTokens ?? state.lastProactiveTokens ?? 0;

    if (!force && tokenBudget != null && tokenBudget > 0) {
      const threshold = Math.floor(tokenBudget * this.config.compactThreshold);
      if (tokensBefore <= threshold) {
        return {
          ok: true,
          compacted: false,
          reason: `Tokens (${tokensBefore}) below threshold (${threshold})`,
          tokensBefore,
        };
      }
    }

    // 窗口未知 + 非 force + 无显式 target：禁用自动压缩
    if (!force && tokenBudget == null && compactTargetTokens == null) {
      return {
        ok: true,
        compacted: false,
        reason: 'contextWindow unknown; auto compact disabled (force/structural still available)',
        tokensBefore,
      };
    }

    this.states.delete(stateKey);

    return {
      ok: true,
      compacted: true,
      reason: force ? 'forced' : 'threshold',
      tokensBefore,
    };
  }

  /**
   * 结构压缩入口（手动 / overflow）— 可无 contextWindow
   *
   * @param input - sessionId + 全量 messages + 可选 summarize
   * @returns 压缩结果
   */
  async compactStructural(input: {
    sessionId: string;
    agentId?: string;
    messages: Message[];
    summarize?: SummarizeFunction;
    compactTargetTokens?: number;
  }): Promise<CompactResult> {
    const estimator = this.config.tokenEstimator;
    const stateKey = compactStateKey(input.sessionId, input.agentId);
    const result = await this.structuralCompact({
      sessionId: input.sessionId,
      stateKey,
      messages: input.messages,
      summarize: input.summarize,
      estimator,
      compactTargetTokens: input.compactTargetTokens,
    });
    return {
      ok: true,
      compacted: Boolean(result.summary),
      reason: 'structural',
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      summary: result.summary || undefined,
    };
  }

  /**
   * 每轮结束后更新状态
   *
   * 使用 LLM 返回的真实 usage 校准 token 估算：
   * 1. 存储真实 reported prompt tokens
   * 2. 记录当前消息数量快照（用于增量估算）
   * 3. 计算校准比率 = actual / estimated
   */
  async afterTurn(params: AfterTurnParams): Promise<void> {
    const { sessionId, agentId, usage, turn } = params;

    if (!usage) return;

    const stateKey = compactStateKey(sessionId, agentId);
    const state = this.states.get(stateKey) ?? {};

    // 存储真实 token 数（provider 报告 prompt ≈ 当前上下文）
    const promptActual =
      usage.inputReportedTokens ??
      usage.inputUncachedTokens + usage.inputCachedTokens + usage.inputCacheWriteTokens;
    state.lastActualTokens = promptActual;

    // 记录消息数量快照（turn 包含本轮消息，估算时用 messages.length - turn.length 得到之前的消息数）
    state.lastUsageMessageCount = turn?.length ?? 0;

    // 计算校准比率：如果上次有估算值，用 actual/estimated 修正后续估算
    if (state.lastEstimatedTokens && state.lastEstimatedTokens > 0 && promptActual > 0) {
      const ratio = promptActual / state.lastEstimatedTokens;
      // 平滑处理：与历史比率加权平均（70% 新值 + 30% 旧值），避免单次异常值过度影响
      state.calibrationRatio = state.calibrationRatio
        ? ratio * 0.7 + state.calibrationRatio * 0.3
        : ratio;
    }

    this.states.set(stateKey, state);
  }

  /**
   * 存储消息（可选）
   *
   * DefaultContextEngine 不需要单独存储消息，
   * 因为消息历史由调用方管理。
   */
  async ingest(_params: IngestParams): Promise<void> {
    // No-op: 消息历史由调用方管理
  }

  /**
   * 构建 LLM 消息格式
   *
   * 将内部 Message 格式转换为 LLM Message 格式。
   */
  /**
   * 使用校准比率修正 token 估算
   *
   * 当有真实 usage 数据时，用 calibrationRatio 修正启发式估算值。
   * 参考 OpenClaw 的 estimateContextTokens() 策略：
   * 优先用真实值，估算只做兜底，校准比率平滑修正偏差。
   */
  private calibrateTokens(sessionId: string, rawEstimated: number, stateKey?: string): number {
    const state = this.states.get(stateKey ?? sessionId);
    if (!state?.calibrationRatio) {
      return rawEstimated;
    }
    // 应用校准比率，限制在 [0.5, 2.0] 范围内防止异常值
    const clampedRatio = Math.max(0.5, Math.min(2.0, state.calibrationRatio));
    return Math.ceil(rawEstimated * clampedRatio);
  }

  private buildLlmMessages(
    messages: Message[],
    systemPrompt: string,
    tools: LLMToolDefinition[],
  ): LLMMessage[] {
    const result: LLMMessage[] = [];

    // 系统提示词（唯一权威来源）。
    // Loop 会把同一内容以 metadata.source==='systemPrompt' unshift 进 messages，
    // 这里必须跳过托管 system，否则 Anthropic/OpenAI 会收到两条重复 system。
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    // knowledgeGrounding：只保留最近一条（旧 grounding 不回放；每轮现算）
    let lastGroundingIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].metadata?.source === 'knowledgeGrounding') lastGroundingIdx = i;
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'system' && msg.metadata?.source === 'systemPrompt') {
        continue;
      }
      if (msg.metadata?.source === 'knowledgeGrounding' && i !== lastGroundingIdx) {
        continue;
      }
      result.push(...this.convertMessage(msg));
    }

    return result;
  }

  /**
   * 转换单条消息为 LLM 格式
   *
   * 处理各种消息类型：
   * - 普通文本消息
   * - 带工具调用的 assistant 消息
   * - 工具结果消息
   * - 多模态消息
   */
  private convertMessage(msg: Message): LLMMessage[] {
    const result: LLMMessage[] = [];

    // 清理无效消息
    if (this.shouldSkipMessage(msg)) {
      return result;
    }

    if (msg.role === 'tool') {
      // 工具结果消息
      // 错误必须进入 content：Loop 写历史时 result=null、error=文案，
      // 若只读 result 会变成 "null"，LLM 看不到失败原因。
      for (const tr of msg.toolResults ?? []) {
        const content =
          tr.error !== undefined
            ? JSON.stringify({ error: tr.error })
            : typeof tr.result === 'string'
              ? tr.result
              : JSON.stringify(tr.result ?? null);
        result.push({
          role: 'tool',
          content,
          tool_call_id: tr.toolCallId,
          name: tr.name,
        });
      }
    } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
      // 带工具调用的 assistant 消息
      result.push({
        role: 'assistant',
        content: getTextContent(msg.content) || null,
        tool_calls: msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      });
    } else if (Array.isArray(msg.content)) {
      // 多模态消息：转换为 LLM 内容块格式
      const llmContent = msg.content.map(block => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text };
        }
        if (block.type === 'image') {
          const source: Record<string, unknown> = { type: 'image_url' };
          if (block.url) {
            source.image_url = { url: block.url };
          } else if (block.data) {
            source.image_url = {
              url: `data:${block.mimeType ?? 'image/png'};base64,${block.data}`,
            };
          }
          return source;
        }
        if (block.type === 'audio') {
          return {
            type: 'input_audio',
            input_audio: {
              data: block.data ?? '',
              format: block.mimeType?.split('/')[1] ?? 'mp3',
            },
          };
        }
        // 其他类型转为文本描述
        return { type: 'text', text: `[${block.type} content]` };
      });
      result.push({
        role: msg.role,
        content: llmContent as Array<{ type: string; [key: string]: unknown }>,
      });
    } else {
      // 普通文本消息
      result.push({
        role: msg.role,
        content: msg.content,
      });
    }

    return result;
  }

  /**
   * 检查是否应该跳过消息
   *
   * 过滤掉可能干扰 LLM 的无效消息：
   * - 空 assistant 消息（无内容、无 toolCalls）
   * - 空 tool 消息（无 toolResults）
   */
  private shouldSkipMessage(msg: Message): boolean {
    // assistant 消息：必须有内容或有 toolCalls
    if (msg.role === 'assistant') {
      const hasContent = Array.isArray(msg.content)
        ? msg.content.length > 0
        : !!msg.content;
      if (!hasContent && (!msg.toolCalls || msg.toolCalls.length === 0)) {
        return true;
      }
    }

    // tool 消息：必须有 toolResults
    if (msg.role === 'tool') {
      if (!msg.toolResults || msg.toolResults.length === 0) {
        return true;
      }
    }

    return false;
  }
}
