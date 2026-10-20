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

import type { Message } from '@octopi-agent/core/types.js';
import { getTextContent } from '@octopi-agent/core/types.js';
import type { LLMMessage, LLMToolDefinition } from '@octopi-agent/core/interfaces/model-provider.js';
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleParams,
  AssembleResult,
  IngestParams,
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
import { toolResultBody } from './tool-result-body.js';
import { buildToolCallLedger } from './llm-summarizer.js';
import {
  agedToolResultPointer,
  applyAgingToMessages,
  computeToolResultAgingPlan,
  resolveToolResultAgingOptions,
  type ToolResultAgingConfig,
  type ToolResultAgingOptions,
  type ToolResultAgingPlan,
} from './tool-result-aging.js';
import { DefaultMessageSelector } from './message-selector.js';
import { HybridCompressor } from './hybrid-compressor.js';
import { DefaultBudgetAllocator } from './budget-allocator.js';
import { SmartRouter } from './smart-router.js';
import type { SmartRouterConfig } from './smart-router.js';
import { compactStateKey } from './compact-key.js';
import { isEngineCarrierSource } from './layer-types.js';
import {
  extractUserMessageText,
  isTurnStartContent,
} from './turn-envelope.js';
import { createCompactEngine } from './capabilities/compact/index.js';
import type { CompactEngine } from './capabilities/compact/index.js';

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
  /**
   * 主动摘要阈值：消息 token / messagesBudget 超过该比例时，
   * 在窗口硬溢出之前先做 LLM 摘要（缓解长会话失忆）。
   * 默认 0.6；`0` = 禁止**新** LLM 压缩（两种模式同闸），**不**丢已有粘滞压缩视图。
   */
  proactiveCompactRatio?: number;
  /**
   * 主动 LLM 摘要冷却（ms）。冷却期内优先缓存重建，避免单 turn 双摘要。
   * 默认 30_000；0 表示不冷却。
   */
  proactiveCooldownMs?: number;
  /**
   * 历史工具结果批量冻结老化（F1-B2）：当前 run 永不老化、近 rawWindow 条跨轮原文、
   * 更旧按 freezeBatch 成批降级为结构化指针（视图级、write-once、禁渐进）。
   * 缺省启用（40 条 / 批 20 / 指针 400 字符）。
   */
  historyAging?: ToolResultAgingConfig;
  /**
   * 工作目标 token（与窗口解耦，F1-B3）。>0 时主动压缩兜底线 = targetTokens ×
   * compactFallbackRatio，不再挂窗口比例（旧挂法 1M 窗口 × 0.6 ≈ 57 万 = 永不触发）。
   * 默认 200000；0 = 退回旧窗口比例模式（proactiveCompactRatio）。
   */
  targetTokens?: number;
  /**
   * compact 兜底线倍数（默认 1.5）。⚠️ 兜底线必须 > B2 老化稳态，否则双机制打架
   * （每 turn 触发 LLM 摘要）；由单测锁死。
   */
  compactFallbackRatio?: number;
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
  /**
   * 上次主动压缩时的全量条数（再压缩增长门 newSinceLast）。
   * 摘要覆盖终点见 lastProactiveCoverEnd。
   */
  lastProactiveMessageCount?: number;
  /**
   * 摘要覆盖终点（下标，不含）= tailStart。
   * sticky 增量起点；若写成 messages.length 会把 tail 误算进覆盖，滑出后丢消息 + 每轮 bust。
   */
  lastProactiveCoverEnd?: number;
  /** 上次主动压缩后的视图 token 估算 */
  lastProactiveTokens?: number;
  /** 上次真正发起 LLM 摘要调用的时间戳（仅 LLM 路径推进；用于冷却） */
  lastProactiveLlmAt?: number;
  /** 上次 LLM 压缩时的全量口径 token（再压缩增长门基准，防持续超线会话周期性重压） */
  lastProactiveFullTokens?: number;
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
  };

  private config: Required<Omit<DefaultContextEngineConfig, 'compactEngine' | 'historyAging'>> & {
    compactEngine: CompactEngine;
    historyAging: ToolResultAgingOptions;
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
      proactiveCompactRatio: config?.proactiveCompactRatio ?? 0.6,
      proactiveCooldownMs: config?.proactiveCooldownMs ?? 30_000,
      historyAging: resolveToolResultAgingOptions(config?.historyAging),
      targetTokens: config?.targetTokens ?? 200_000,
      // <1 或非法值回落缺省——0 会把兜底线压成 0（压缩风暴），不是「禁用」语义
      compactFallbackRatio:
        config?.compactFallbackRatio != null && config.compactFallbackRatio >= 1
          ? config.compactFallbackRatio
          : 1.5,
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

    // F1-B2：老化计划基于**完整历史**（append-only）一次算好、随视图复用——
    // 按裁剪视图重算会让已降级条目回原文、批量边界来回翻转（烧前缀缓存）。
    // 估算（estimateLLMMessages）作用于老化后的 LLM 视图，尺子与实际请求一致。
    const agingPlan = computeToolResultAgingPlan(messages, this.config.historyAging);

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
            lastProactiveCoverEnd:
              restored.lastProactiveCoverEnd ?? existing?.lastProactiveCoverEnd,
            lastProactiveTokens: restored.lastProactiveTokens ?? existing?.lastProactiveTokens,
          });
        }
      }
    }

    // 未知窗口：无 token 预算 → 不按 budget 截消息。
    // F1-B3：targetTokens>0 时兜底压缩与窗口无关，窗口未知照样执行（工作目标解耦）；
    // targetTokens=0（legacy）保持旧行为：跳过 proactive。
    // 已有结构压缩摘要时，用 head + summary + tail 视图
    if (!windowKnown && !targetKnown && budgetCap == null) {
      const proactive =
        this.config.targetTokens > 0
          ? await this.applyProactiveCompact({
              sessionId,
              stateKey,
              messages,
              messagesBudget: 0,
              agingPlan,
              summarize,
              estimator,
              emit,
            })
          : { messages };
      const view =
        proactive.messages !== messages
          ? { messages: proactive.messages, droppedSummary: proactive.droppedSummary }
          : this.buildStructuralView(sessionId, messages, emit, stateKey);
      const llmMessages = this.buildLlmMessages(view.messages, systemPrompt, tools, agingPlan);
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
      agingPlan,
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
      const llmMessages = this.buildLlmMessages(selection.kept, systemPrompt, tools, agingPlan);
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
          // 兜底：保守降级（head + 工具账本 + tail），禁止只留 4 条
          compressedOverflow = await this.conservativeTruncate(
            selection.overflow,
            estimator,
          );
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
      // 压缩失败：保守降级，不中断本轮
      compressedOverflow = await this.conservativeTruncate(
        selection.overflow,
        estimator,
      );
      droppedSummary = 'Context compact failed; fell back to truncation';
    }

    // 6. 重组（严格时间序）：protectHead → 压缩旧 middle → 未压新 middle → tail
    //    kept = [protectHead, selectedMiddle, tail]；overflow = 较旧 middle。
    //    禁止把 compressedOverflow 插在 selectedMiddle 之后（乱序会伤推理且每轮边界漂移打穿前缀）。
    const tailLen = selection.tail.length;
    const keptBody = selection.kept.slice(0, Math.max(0, selection.kept.length - tailLen));
    const headCount = Math.min(this.config.protectFirstN, workingMessages.length);
    const protectHead = keptBody.slice(0, Math.min(headCount, keptBody.length));
    const selectedMiddle = keptBody.slice(protectHead.length);
    const reassembled = [
      ...protectHead,
      ...compressedOverflow,
      ...selectedMiddle,
      ...selection.tail,
    ];

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
    });

    // 8. 构建 LLM 消息（校准基 = 老化后 LLM 视图估算——尺子必须量实际请求，
    //    不能像旧代码存 raw Message 估算，否则 calibrationRatio 系统性漂移）
    const llmMessages = this.buildLlmMessages(reassembled, systemPrompt, tools, agingPlan);
    const rawEstimatedTokens = estimateLLMMessages(llmMessages);
    this.states.set(stateKey, {
      ...this.states.get(stateKey),
      lastEstimatedTokens: rawEstimatedTokens,
    });
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
      lastProactiveCoverEnd: state?.lastProactiveCoverEnd,
      lastProactiveTokens: state?.lastProactiveTokens,
    };
  }

  /**
   * 主动摘要：消息 token 超过 messagesBudget × ratio 时，在硬溢出前压缩
   *
   * 语义（粘滞 + 禁新 LLM）：
   * - **压缩视图粘滞**：一旦建立过压缩态（previousSummary 或 lastProactiveMessageCount），
   *   后续装配优先复用 head+摘要/机械中间+tail，不因估算回落或 ratio=0 而打回全量
   *   （全量请求会 bust 前缀缓存，且等于撤销已完成的压缩）。
   * - **proactiveCompactRatio=0**：禁止**发起新的** LLM 压缩；**不**丢弃已有压缩视图。
   * - 策略：
   *   - 未超阈值且无压缩态：原样返回
   *   - 超阈值且需要新一轮压缩（上次压缩后新增消息够多）：LLM 压缩中间段并产出语义摘要
   *   - 已有压缩态且增量小或冷却中或禁新 LLM：零 LLM 重建视图
   */
  private async applyProactiveCompact(params: {
    sessionId: string;
    /** E4 engine state key; defaults to sessionId */
    stateKey?: string;
    messages: Message[];
    messagesBudget: number;
    agingPlan: ToolResultAgingPlan;
    summarize?: SummarizeFunction;
    estimator: TokenEstimator;
    emit?: ContextEmitFn;
  }): Promise<{ messages: Message[]; droppedSummary?: string }> {
    const { sessionId, messages, messagesBudget, agingPlan, summarize, estimator, emit } = params;
    const stateKey = params.stateKey ?? sessionId;
    const ratio = this.config.proactiveCompactRatio;
    const state = this.states.get(stateKey);

    if (messages.length === 0) {
      return { messages };
    }

    const protectFirstN = this.config.protectFirstN;
    const protectLastN = this.config.protectLastN;

    // 压缩态粘滞：有摘要或覆盖计数即认定「已压缩」，之后不回全量
    const hasCompactView =
      state?.lastProactiveMessageCount != null || !!state?.previousSummary;

    // 边界对齐（不拆 tool_call/tool_result 对）——两形状都会被严格网关 400
    const { headEnd, tailStart } = this.alignViewSplit(messages, protectFirstN, protectLastN);
    const head = messages.slice(0, headEnd);
    const tail = messages.slice(tailStart);
    const middle = this.semanticHistory(messages.slice(headEnd, tailStart));

    const headTailTokens = estimator.estimateMessages(head) + estimator.estimateMessages(tail);

    /**
     * 零 LLM 粘滞重建。
     *
     * 有语义摘要时：head + 摘要 + **摘要覆盖点之后的增量** + tail。
     * 增量（上次 `lastProactiveMessageCount` 之后、已滑出 tail 的消息）不得被旧摘要顶掉——
     * 否则长 tool turn 会丢当前 run 前半段工作记录。
     *
     * @param targetMiddleTokens - 增量段机械压缩预算
     * @returns 重建视图；无法重建时返回 null
     */
    const rebuildStickyView = async (
      targetMiddleTokens: number,
    ): Promise<{ messages: Message[] } | null> => {
      if (messages.length <= protectFirstN + protectLastN) {
        return null;
      }
      if (state?.previousSummary) {
        const summaryMsg: Message = {
          role: 'user',
          content: wrapContextSummary(state.previousSummary),
          timestamp: Date.now(),
          metadata: { source: 'contextSummary' as const },
        };
        // 摘要覆盖到 lastProactiveCoverEnd（tailStart）；之后的消息是增量，必须保留
        const coverUpTo = state.lastProactiveCoverEnd ?? 0;
        const sinceIdx = Math.max(coverUpTo, headEnd);
        const sinceCompact = this.semanticHistory(messages.slice(sinceIdx, tailStart));
        let extra: Message[] = sinceCompact;
        if (sinceCompact.length > 0) {
          const extraTokens = estimator.estimateMessages(sinceCompact);
          if (extraTokens > targetMiddleTokens) {
            try {
              const compressedExtra = await this.config.compressor.compress({
                messages: sinceCompact,
                targetTokens: targetMiddleTokens,
                tokenEstimator: estimator,
              });
              extra = compressedExtra.result;
            } catch {
              // 机械压缩失败：保留增量原文（宁可胖，不可丢）
              extra = sinceCompact;
            }
          }
        }
        return { messages: [...head, summaryMsg, ...extra, ...tail] };
      }
      if (middle.length === 0) {
        return null;
      }
      try {
        const compressed = await this.config.compressor.compress({
          messages: middle,
          targetTokens: targetMiddleTokens,
          tokenEstimator: estimator,
        });
        return { messages: [...head, ...compressed.result, ...tail] };
      } catch {
        return null;
      }
    };

    // F1-B3：尺子量**老化视图**（实际请求的保守上界）——raw 估算会把 B2 稳态误判超线（双机制打架）。
    // 压缩输入仍用原 messages（摘要质量需要原文）。
    const currentTokens = estimator.estimateMessages(
      applyAgingToMessages(messages, agingPlan, this.config.historyAging),
    );
    // F1-B3：兜底线挂工作目标（targetTokens × compactFallbackRatio），与窗口解耦——
    // 旧挂法 1M 窗口 × 0.6 ≈ 57 万 = 永不触发（尺子挂错地方）。
    // 小窗口再取 min（窗口比例线）：否则 proactive（有门槛/冷却）被挤死、溢出路径
    // （无门槛）每 turn 压缩——双机制打架换位置（评审 H1）。窗口未知（messagesBudget=0）只用目标线。
    const targetLine = Math.ceil(this.config.targetTokens * this.config.compactFallbackRatio);
    const legacyLine = messagesBudget > 0 ? Math.floor(messagesBudget * ratio) : Number.POSITIVE_INFINITY;
    const threshold = this.config.targetTokens > 0 ? Math.min(targetLine, legacyLine) : legacyLine;

    const targetMiddleTokens = Math.max(
      200,
      Math.floor(threshold * 0.55) - headTailTokens,
    );

    // 新 LLM 压缩闸门（方案 E）：
    // - ratio=0 或无 summarize：禁止新 LLM，不丢已有压缩态
    // - **turn 内**（最近真实 user 之后已有工具活动）：禁止新 LLM 摘要——
    //   活动工作记录在 middle 里，摘要会吃掉当前 run；只允许机械分级
    // - turn 边界（新 user 刚到、工具活动尚未开始）：才允许对更早历史做 LLM 摘要
    const midTurn = isMidTurn(messages);
    const allowNewLlmCompact = !!summarize && ratio > 0 && !midTurn;

    // 未超线：无压缩态则原样；有压缩态则粘滞重建（禁止回全量）
    if (currentTokens <= threshold) {
      if (!hasCompactView) {
        return { messages };
      }
      const sticky = await rebuildStickyView(targetMiddleTokens);
      if (!sticky) {
        return { messages };
      }
      const reducedTokens = estimator.estimateMessages(sticky.messages);
      this.states.set(stateKey, {
        ...state,
        lastProactiveTokens: reducedTokens,
        lastEstimatedTokens: reducedTokens,
      });
      return { messages: sticky.messages };
    }

    if (messages.length <= protectFirstN + protectLastN) {
      return { messages };
    }

    // 判据：是否开启新一轮压缩 —— 只看「自上次压缩以来的新增条数」与冷却。
    // 注意：只比「自上次压缩以来新增条数」，不要拿全量 token 和压缩后视图比；
    // 也不要把「有无 previousSummary」当判据：压缩可能是机械截断（无摘要），
    // 拿摘要存在与否当判据会让无摘要会话每轮重裁、复用分支永远进不去。
    const lastCount = state?.lastProactiveMessageCount;
    const newSinceLast = lastCount === undefined ? messages.length : messages.length - lastCount;
    const minNewForResummarize = Math.max(3, Math.floor(protectLastN * 0.25));
    // 增长门（target 模式；防「偶发兜底」变「周期压缩」）：持续超线的会话全量口径不回落，
    // 若只看消息增量，每攒 minNewForResummarize 条就全量重压（LLM 成本/延迟失控）。
    // 只有全量口径较上次压缩实质增长（≥ 25% 阈值）才允许再打 LLM。
    // legacy（targetTokens=0）保持既有「攒够增量重试」节奏不动。
    const lastFull = state?.lastProactiveFullTokens;
    const grownEnough =
      this.config.targetTokens <= 0 ||
      lastFull === undefined ||
      currentTokens >= lastFull + Math.max(1, Math.floor(threshold * 0.25));
    const needNewCompaction = newSinceLast >= minNewForResummarize && grownEnough;

    // 冷却：刚做过 LLM 摘要则优先缓存重建，降低单 turn 双摘要概率
    const cooldownMs = this.config.proactiveCooldownMs;
    const inCooldown =
      cooldownMs > 0 &&
      state?.lastProactiveLlmAt != null &&
      Date.now() - state.lastProactiveLlmAt < cooldownMs;

    // 复用重建（零 LLM）：已压缩过，且增量小或在冷却期或禁止新 LLM。
    if (
      hasCompactView &&
      (!allowNewLlmCompact || !needNewCompaction || inCooldown)
    ) {
      const sticky = await rebuildStickyView(targetMiddleTokens);
      if (sticky) {
        const reducedTokens = estimator.estimateMessages(sticky.messages);
        // 只更新视图 token，**不要**改 lastProactiveMessageCount：
        // 该字段表示「压缩覆盖到的全量条数」，只能在真正完成一次压缩时推进。
        // 若复用重建也改成 messages.length，每轮 +1 会永远凑不满再压缩阈值。
        this.states.set(stateKey, {
          ...state,
          lastProactiveTokens: reducedTokens,
          lastEstimatedTokens: reducedTokens,
        });
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
        return { messages: sticky.messages };
      }
    }

    // 禁新 LLM 且无粘滞视图：超线也只走机械（不打摘要 LLM）
    if (!allowNewLlmCompact) {
      const sticky = await rebuildStickyView(targetMiddleTokens);
      return sticky ? { messages: sticky.messages } : { messages };
    }

    // 需要新一轮压缩：压缩 head/tail 之间的中间段（语义历史，不含 grounding）。
    // requireSummary：主交付是语义摘要（缓解长会话失忆），机械截断达标也必须补摘要——
    // 否则 previousSummary 永远为空、复用分支永远进不去，每个 turn 都会重裁+发通知。
    if (middle.length === 0) {
      return { messages };
    }

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
        requireSummary: true,
      });
    } catch (err) {
      emit?.({
        type: 'context.compact.error',
        sessionId,
        reason: 'proactive',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - proactiveStart,
      });
      // 主动摘要失败：优先粘滞重建，其次不改视图
      const sticky = await rebuildStickyView(targetMiddleTokens);
      return sticky ? { messages: sticky.messages } : { messages };
    }

    const reduced = [...head, ...compressed.result, ...tail];
    const reducedTokens = estimator.estimateMessages(reduced);
    const actualSummary =
      this.extractSummaryText(compressed.result) ?? state?.previousSummary;

    this.states.set(stateKey, {
      ...state,
      previousSummary: actualSummary,
      lastEstimatedTokens: reducedTokens,
      // 增长门用全量条数；覆盖终点单独记 tailStart（tail 不在摘要内）
      lastProactiveMessageCount: messages.length,
      lastProactiveCoverEnd: tailStart,
      lastProactiveTokens: reducedTokens,
      lastProactiveFullTokens: currentTokens,
      // 本轮（requireSummary）真正发起过 LLM 摘要调用（成功或失败均算发起），
      // 时间戳用于冷却；复用重建与纯机械降级不得推进此字段。
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

  /**
   * 保守降级（overflow **middle 替换体**）：工具账本说明 + 近尾
   * 外层 head/tail 由 assemble 重组拼接，此处不得重复携带。
   *
   * @param messages - 待降级消息（overflow 段）
   * @param _estimator - token 估算器（保留签名对称）
   * @returns 降级后的消息列表
   */
  private async conservativeTruncate(
    messages: Message[],
    _estimator: TokenEstimator,
  ): Promise<Message[]> {
    const keepCount = Math.min(Math.max(6, Math.ceil(messages.length * 0.15)), messages.length);
    const kept = messages.slice(-keepCount);
    const dropped = messages.slice(0, messages.length - keepCount);
    // 无可丢弃：原样返回（禁止「0 removed」假通知膨胀）
    if (dropped.length === 0) {
      return [...messages];
    }
    const body = buildToolCallLedger(dropped);
    const notice: Message = {
      role: 'user',
      content: body
        ? `[Context truncated: ${dropped.length} earlier messages removed to fit context window]\n[Tool call ledger — do NOT redo these unless explicitly asked]\n${body}`
        : `[Context truncated: ${dropped.length} earlier messages removed to fit context window]`,
      timestamp: Date.now(),
      metadata: { source: 'contextSummary' as const },
    };
    return [notice, ...kept];
  }

  /**
   * 从压缩结果中提取语义摘要正文（contextSummary 标记或 [Conversation Summary] 前缀）。
   * 机械降级的占位说明（[Context truncated / [Context compressed / [Structural compact]）
   * 不算语义摘要：把它们当摘要存入 previousSummary 会污染增量合并输入，
   * 并让复用分支拿到假摘要、掩盖「从未真正摘要」的事实。
   */
  private extractSummaryText(compressed: Message[]): string | undefined {
    for (const m of compressed) {
      if (
        m.metadata?.source === 'contextSummary' &&
        typeof m.content === 'string' &&
        m.content.trim() &&
        !this.isMechanicalNotice(m.content)
      ) {
        return m.content;
      }
    }
    for (const m of compressed) {
      if (
        typeof m.content === 'string' &&
        m.content.includes('[Conversation Summary]') &&
        !this.isMechanicalNotice(m.content)
      ) {
        return m.content;
      }
    }
    return undefined;
  }

  /**
   * 机械降级占位说明判别（非语义摘要）：首条实质行以占位标记开头即认定。
   * 只看首行而非全文 includes——真实摘要引用这些字符串（如记录「曾发生截断」）不得被误杀。
   *
   * @param text - 候选摘要正文
   * @returns 是否为机械占位说明
   */
  private isMechanicalNotice(text: string): boolean {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line === '[Conversation Summary]') continue;
      return (
        line.startsWith('[Context truncated:') ||
        line.startsWith('[Context compressed:') ||
        line.startsWith('[Structural compact]')
      );
    }
    return false;
  }

  /**
   * 判断是否工具结果消息（视图边界对齐用）
   *
   * @param msg - 待判定消息
   * @returns 是否为工具结果消息
   */
  private isToolResultMessage(msg: Message): boolean {
    return msg.role === 'tool' || (msg.toolResults?.length ?? 0) > 0;
  }

  /**
   * 视图切分边界对齐（不拆 tool_call/tool_result 对）
   *
   * head 不得停在带 toolCalls 的 assistant 上（其结果落入中间段，视图里会成悬空调用）；
   * tail 不得起于 tool 结果（其调用在中间段，会成孤儿结果）——两种形状都会被严格网关 400。
   *
   * @param messages - 全量消息
   * @param headCount - 期望头部条数
   * @param tailCount - 期望尾部条数
   * @returns 对齐后的 head 终点（不含）与 tail 起点（含）
   */
  private alignViewSplit(
    messages: Message[],
    headCount: number,
    tailCount: number,
  ): { headEnd: number; tailStart: number } {
    let headEnd = Math.min(headCount, messages.length);
    while (headEnd > 0 && (messages[headEnd - 1]?.toolCalls?.length ?? 0) > 0) {
      headEnd--;
    }
    let tailStart = Math.max(0, messages.length - tailCount);
    while (tailStart > headEnd && this.isToolResultMessage(messages[tailStart]!)) {
      tailStart--;
    }
    return { headEnd, tailStart };
  }

  /**
   * 压缩/摘要的语义输入：丢掉托管 system 与 turn 信封元数据
   * （turn_context picks 不进 previousSummary——防陈旧择取固化进摘要）；
   * turn_start 只保留 <user_message> 正文。
   */
  private semanticHistory(messages: Message[]): Message[] {
    const out: Message[] = [];
    for (const m of messages) {
      if (m.role === 'system' && m.metadata?.source === 'systemPrompt') continue;
      if (m.metadata?.source === 'turnEnd') continue;
      if (m.metadata?.source === 'knowledgeGrounding') continue;
      if (m.metadata?.source === 'runtimeSnapshot') continue;
      if (m.metadata?.source === 'sessionAttachment') continue;
      if (isTurnStartContent(m.content)) {
        out.push({ ...m, content: extractUserMessageText(m.content) });
        continue;
      }
      out.push(m);
    }
    return out;
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
    // 边界对齐（不拆 tool_call/tool_result 对）：与 applyProactiveCompact 同款——
    // 未对齐的 head/tail 会被严格网关 400
    const { headEnd, tailStart } = this.alignViewSplit(messages, protectFirstN, protectLastN);
    const head = messages.slice(0, headEnd);
    const tail = messages.slice(tailStart);
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
  }): Promise<{
    summary?: string;
    compacted: boolean;
    tokensBefore: number;
    tokensAfter: number;
    coveredMessageCount?: number;
  }> {
    const { sessionId, messages, summarize, estimator } = params;
    const stateKey = params.stateKey ?? sessionId;
    const protectFirstN = this.config.protectFirstN;
    const protectLastN = this.config.protectLastN;
    const tokensBefore = estimator.estimateMessages(messages);
    const state = this.states.get(stateKey);

    if (messages.length <= protectFirstN + protectLastN) {
      return {
        summary: state?.previousSummary,
        compacted: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        coveredMessageCount: state?.lastProactiveCoverEnd,
      };
    }

    // 覆盖坐标与 applyProactiveCompact / rebuildStickyView 同一系：
    // 原始 messages 上 alignViewSplit → middle 语义历史 → 摘要；coverEnd = tailStart。
    // 禁止对 semanticHistory(全量) 切 protectHead/Tail（过滤数组下标 ≠ 原始下标，会丢消息）。
    const { headEnd, tailStart } = this.alignViewSplit(messages, protectFirstN, protectLastN);
    const middle = this.semanticHistory(messages.slice(headEnd, tailStart));

    const outcome = await this.config.compactEngine.compactMessages(
      middle,
      {
        protectHead: 0,
        protectTail: 0,
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

    // 与 extractSummaryText 同一不变量：机械占位说明不是语义摘要，不得进入 previousSummary
    // （增量合并输入、复用重建依据、持久化快照来源）——否则占位会经快照恢复再次污染状态。
    const semanticSummary =
      outcome.summary && !this.isMechanicalNotice(outcome.summary) ? outcome.summary : undefined;
    const summary = semanticSummary ?? state?.previousSummary;
    const tokensAfter = outcome.tokensAfter ?? tokensBefore;

    this.states.set(stateKey, {
      ...state,
      previousSummary: summary,
      lastProactiveMessageCount: messages.length,
      lastProactiveCoverEnd: tailStart,
      lastProactiveTokens: tokensAfter,
      lastEstimatedTokens: tokensAfter,
      lastProactiveLlmAt: summarize ? Date.now() : state?.lastProactiveLlmAt,
    });

    return {
      summary,
      compacted: outcome.compacted,
      tokensBefore,
      tokensAfter,
      coveredMessageCount: tailStart,
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
      compacted: result.compacted,
      reason: 'structural',
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      summary: result.summary,
      coveredMessageCount: result.coveredMessageCount,
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
    aging: ToolResultAgingPlan,
  ): LLMMessage[] {
    const result: LLMMessage[] = [];

    // 系统提示词（唯一权威来源）。
    // Loop 会把同一内容以 metadata.source==='systemPrompt' unshift 进 messages，
    // 这里必须跳过托管 system，否则 Anthropic/OpenAI 会收到两条重复 system。
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    // 全回放（append-only）：turn_context / turn_end / 历史槽位一律保留，
    // 否则历史中部删改会打穿 provider 前缀缓存。
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'system' && msg.metadata?.source === 'systemPrompt') {
        continue;
      }
      result.push(...this.convertMessage(msg, aging));
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
  private convertMessage(msg: Message, aging?: ToolResultAgingPlan): LLMMessage[] {
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
        // F1-B2：老化条目降级为结构化指针（错误文案保真在指针内；tool_call 配对不动）
        const content =
          aging && aging.agedIds.has(tr.toolCallId)
            ? agedToolResultPointer(tr, aging.argsById.get(tr.toolCallId), this.config.historyAging)
            : toolResultBody(tr);
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
          // 仅 data:/http(s) 可进 vision；本地路径降为文字指针，避免 provider 拒收
          const url = typeof block.url === 'string' ? block.url : '';
          const canSendImage =
            (block.data && block.data.length > 0) ||
            /^https?:\/\//i.test(url) ||
            /^data:/i.test(url);
          if (canSendImage) {
            const source: Record<string, unknown> = { type: 'image_url' };
            if (block.data) {
              source.image_url = {
                url: `data:${block.mimeType ?? 'image/png'};base64,${block.data}`,
              };
            } else {
              source.image_url = { url };
            }
            return source;
          }
          return {
            type: 'text',
            text: `[image: ${block.alt ?? 'attachment'}${url ? ` | path: ${url}` : ''}]`,
          };
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
        // file / 其他：文字指针（正文在 sessionAttachment 资料块；深读用 file_read）
        if (block.type === 'file') {
          const name = block.name ?? 'attachment';
          const size = block.sizeBytes != null ? ` ${block.sizeBytes}B` : '';
          const mime = block.mimeType ? ` ${block.mimeType}` : '';
          const path = block.url ? ` | path: ${block.url}` : '';
          return {
            type: 'text',
            text: `[attachment: ${name}${mime}${size}${path} — use file_read to open]`,
          };
        }
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

/**
 * 是否处于 turn 内（最近真实 user 消息之后已有工具活动）
 *
 * 方案 E：turn 内 middle 全是当前 run 工作记录，禁止 LLM 摘要；
 * turn 边界（新 user 刚落、尚无工具）才允许对更早历史做语义压缩。
 *
 * 「真实 user」= 无 agentId 归因，且非引擎载体（含 `engineHint` reliability 注入）。
 * 多 agent 共线时带 agentId 的 user 不重置本边界（只认主对话发言）。
 *
 * @param messages - 全量消息
 * @returns 是否 turn 内
 */
export function isMidTurn(messages: Message[]): boolean {
  let lastGenuineUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (msg.agentId) continue;
    if (isEngineCarrierSource(msg.metadata?.source)) continue;
    lastGenuineUserIdx = i;
  }
  if (lastGenuineUserIdx < 0) return false;
  for (let i = lastGenuineUserIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (
      msg.role === 'tool' ||
      (msg.toolResults?.length ?? 0) > 0 ||
      (msg.toolCalls?.length ?? 0) > 0
    ) {
      return true;
    }
  }
  return false;
}
