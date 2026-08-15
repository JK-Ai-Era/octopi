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
import type { LLMMessage, ToolDefinition } from '../../core/interfaces/model-provider.js';
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
} from '../../core/interfaces/context-engine.js';
import { HeuristicTokenEstimator, estimateLLMMessages } from './token-estimator.js';
import { DefaultMessageSelector } from './message-selector.js';
import { HybridCompressor } from './hybrid-compressor.js';
import { DefaultBudgetAllocator } from './budget-allocator.js';
import { SmartRouter } from './smart-router.js';
import type { SmartRouterConfig } from './smart-router.js';

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
}

// ── 内部状态 ──

interface CompactState {
  /** 上次摘要 */
  previousSummary?: string;
  /** 上次实际 token 数（来自 LLM usage） */
  lastActualTokens?: number;
  /** 上次估算 token 数 */
  lastEstimatedTokens?: number;
  /** 上次 usage 对应的消息数量快照（用于增量估算） */
  lastUsageMessageCount?: number;
  /** 估算校准比率 = actual / estimated（用于修正后续估算） */
  calibrationRatio?: number;
}

// ── 引擎实现 ──

export class DefaultContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: 'default',
    name: 'Default Context Engine',
    ownsCompaction: true,
  };

  private config: Required<DefaultContextEngineConfig>;
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
      messages,
      systemPrompt,
      tools,
      tokenBudget,
      contextWindow,
      signal,
      tokenEstimator,
      summarize,
    } = params;

    const estimator = tokenEstimator ?? this.config.tokenEstimator;

    // 1. 计算可用预算
    const budget = this.config.budgetAllocator.allocate({
      tokenBudget,
      contextWindow,
      systemPromptTokens: estimator.estimateText(systemPrompt),
      toolTokens: estimator.estimateTools(tools),
    });

    // 2. 四区域消息选择（MessageSelector）
    //    head（头部保护）+ overflow（可压缩）+ tail（尾部保护）
    const selection = this.config.messageSelector.select(
      messages,
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
      const estimatedTokens = this.calibrateTokens(sessionId, rawEstimatedTokens);

      this.states.set(sessionId, {
        ...this.states.get(sessionId),
        lastEstimatedTokens: rawEstimatedTokens,
      });

      return {
        messages: llmMessages,
        estimatedTokens,
        systemPrompt,
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
    const state = this.states.get(sessionId);
    const previousSummary = state?.previousSummary;

    let compressedOverflow: Message[];
    let droppedSummary: string | undefined;

    // 计算溢出部分的压缩目标：head + selectedMiddle + tail 已占的 token
    // selection.estimatedTokens = head + selectedMiddle + tail 的 token 数
    // 压缩后 overflow 应使总 token 在预算内
    const keptTokens = selection.estimatedTokens;
    const overflowTargetTokens = Math.max(500, budget.messagesBudget - keptTokens);

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

    // 6. 重组：head + compressed overflow + tail
    //    kept = head + (部分 middle) + tail，tail 和 kept 有重叠
    //    head = kept 中去掉 tail 的部分（包含 head + 部分 middle）
    const head = selection.kept.length > selection.tail.length
      ? selection.kept.slice(0, selection.kept.length - selection.tail.length)
      : [];
    const reassembled = [...head, ...compressedOverflow, ...selection.tail];

    // 7. 更新状态
    const compressedTokens = estimator.estimateMessages(reassembled);
    this.states.set(sessionId, {
      previousSummary: droppedSummary,
      lastEstimatedTokens: compressedTokens,
    });

    // 8. 构建 LLM 消息
    const llmMessages = this.buildLlmMessages(reassembled, systemPrompt, tools);
    const rawEstimatedTokens = estimateLLMMessages(llmMessages);
    const estimatedTokens = this.calibrateTokens(sessionId, rawEstimatedTokens);

    return {
      messages: llmMessages,
      estimatedTokens,
      systemPrompt,
      droppedSummary,
    };
  }

  /**
   * 压缩存储
   *
   * 当存储超限时，压缩旧消息。
   */
  async compact(params: CompactParams): Promise<CompactResult> {
    const { sessionId, tokenBudget, force, currentTokenCount } = params;

    // 获取状态
    const state = this.states.get(sessionId);
    if (!state) {
      return {
        ok: true,
        compacted: false,
        reason: 'No state found for session',
        tokensBefore: 0,
      };
    }

    const tokensBefore = currentTokenCount ?? state.lastEstimatedTokens ?? 0;

    // 检查是否需要压缩
    const threshold = Math.floor(tokenBudget * this.config.compactThreshold);
    if (!force && tokensBefore <= threshold) {
      return {
        ok: true,
        compacted: false,
        reason: `Tokens (${tokensBefore}) below threshold (${threshold})`,
        tokensBefore,
      };
    }

    // 清除状态（下次 assemble 时会重新压缩）
    this.states.delete(sessionId);

    return {
      ok: true,
      compacted: true,
      reason: 'State cleared for recompression',
      tokensBefore,
      tokensAfter: 0,
    };
  }

  /**
   * 每轮结束后更新状态
   *
   * 使用 LLM 返回的真实 usage 校准 token 估算：
   * 1. 存储真实 promptTokens
   * 2. 记录当前消息数量快照（用于增量估算）
   * 3. 计算校准比率 = actual / estimated
   */
  async afterTurn(params: AfterTurnParams): Promise<void> {
    const { sessionId, usage, turn } = params;

    if (!usage) return;

    const state = this.states.get(sessionId) ?? {};

    // 存储真实 token 数
    state.lastActualTokens = usage.promptTokens;

    // 记录消息数量快照（turn 包含本轮消息，估算时用 messages.length - turn.length 得到之前的消息数）
    state.lastUsageMessageCount = turn?.length ?? 0;

    // 计算校准比率：如果上次有估算值，用 actual/estimated 修正后续估算
    if (state.lastEstimatedTokens && state.lastEstimatedTokens > 0 && usage.promptTokens > 0) {
      const ratio = usage.promptTokens / state.lastEstimatedTokens;
      // 平滑处理：与历史比率加权平均（70% 新值 + 30% 旧值），避免单次异常值过度影响
      state.calibrationRatio = state.calibrationRatio
        ? ratio * 0.7 + state.calibrationRatio * 0.3
        : ratio;
    }

    this.states.set(sessionId, state);
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
  private calibrateTokens(sessionId: string, rawEstimated: number): number {
    const state = this.states.get(sessionId);
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
    tools: ToolDefinition[],
  ): LLMMessage[] {
    const result: LLMMessage[] = [];

    // 系统提示词
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    // 消息
    for (const msg of messages) {
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
      for (const tr of msg.toolResults ?? []) {
        result.push({
          role: 'tool',
          content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
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
