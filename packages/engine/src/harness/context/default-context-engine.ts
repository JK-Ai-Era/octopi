/**
 * DefaultContextEngine — 默认上下文引擎
 *
 * Harness 层的默认实现，整合所有组件：
 * - MessageSelector：消息选择
 * - capabilities/compact：压缩执行（交接摘要 + 机械降级阶梯；本引擎只做触发/状态）
 * - BudgetAllocator：预算分配
 * - TokenEstimator：Token 估算
 *
 * 特性：
 * - 四区域划分（头部保护 + 中间可压缩 + 尾部保护）
 * - 边界对齐（不拆分 tool_call/tool_result 对）
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
  AfterStepParams,
  TokenEstimator,
  SummarizeFunction,
  MessageSelector,
  BudgetAllocator,
  ContextEmitFn,
  ContextCompactSnapshot,
} from './types.js';
import { HeuristicTokenEstimator, estimateLLMMessages } from './token-estimator.js';
import { toolResultBody } from './tool-result-body.js';
import {
  agedToolResultPointer,
  agedToolArgDigest,
  applyAgingToMessages,
  computeToolResultAgingPlan,
  resolveToolResultAgingOptions,
  type ToolResultAgingConfig,
  type ToolResultAgingOptions,
  type ToolResultAgingPlan,
} from './tool-result-aging.js';
import { DefaultMessageSelector } from './message-selector.js';
import { DefaultBudgetAllocator } from './budget-allocator.js';
import { SmartRouter } from './smart-router.js';
import type { SmartRouterConfig } from './smart-router.js';
import { compactStateKey } from './compact-key.js';
import { isTurnAnchor, isScheduleNotice } from './layer-types.js';
import { createCompactEngine } from './capabilities/compact/index.js';
import type { CompactEngine, CompactOutcome } from './capabilities/compact/index.js';
import {
  alignViewSplit,
  asSummaryMessage,
  isMechanicalNotice,
  ledgerTruncate,
  semanticHistory,
} from './capabilities/compact/index.js';

// ── 配置 ──

export interface DefaultContextEngineConfig {
  /** 消息选择策略 */
  messageSelector?: MessageSelector;
  /** 预算分配策略 */
  budgetAllocator?: BudgetAllocator;
  /** Token 估算器 */
  tokenEstimator?: TokenEstimator;
  /** 智能路由器配置 */
  router?: SmartRouterConfig;
  /** 头部保护消息数（默认 5：交接快照的「任务前因」） */
  protectFirstN?: number;
  /** 尾部保护消息数（默认 20：进度锚，明确任务截止到哪） */
  protectLastN?: number;
  /** 摘要软目标预算（P1c 缺省 clamp(2%, 2k, 8k)）：可配置 ratioPct/minTokens/maxTokens */
  summaryBudget?: { ratioPct?: number; minTokens?: number; maxTokens?: number };
  /**
   * 窗口比例线：消息 token / messagesBudget 超过该比例时，
   * 在窗口硬溢出之前先做主动压缩（缓解长会话失忆 / 窗口到顶未触发）。
   * 默认 0.6；`0` = 禁止**发起新的**路径 A 压缩（不只禁 LLM），**不**丢已有粘滞压缩视图。
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
   * 工作目标 token（与窗口解耦，F1-B3）。>0 时主动压缩目标线 = targetTokens ×
   * compactFallbackRatio，并与窗口比例线取 min。
   * 默认 200000；0 = 只挂窗口比例线（proactiveCompactRatio）。
   */
  targetTokens?: number;
  /**
   * 目标线倍数（默认 3）。触发线 = targetTokens × compactFallbackRatio；
   * 须 > B2 老化稳态，否则双机制打架（每 turn 触发压缩）。1.5 时刚过目标就压、
   * 压完只回到约目标附近，压缩收益太小；3 让压缩成为有意义的收缩。
   * ⚠️ 窗口比例线（messagesBudget × proactiveCompactRatio）始终并存，防小窗口到顶未触发。
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
      budgetAllocator: config?.budgetAllocator ?? new DefaultBudgetAllocator(),
      tokenEstimator,
      router: config?.router ?? {},
      protectFirstN: config?.protectFirstN ?? 5,
      protectLastN: config?.protectLastN ?? 20,
      summaryBudget: config?.summaryBudget ?? {},
      proactiveCompactRatio: config?.proactiveCompactRatio ?? 0.6,
      proactiveCooldownMs: config?.proactiveCooldownMs ?? 30_000,
      historyAging: resolveToolResultAgingOptions(config?.historyAging),
      targetTokens: config?.targetTokens ?? 200_000,
      // <1 或非法值回落缺省——0 会把目标线压成 0（压缩风暴），不是「禁用」语义
      compactFallbackRatio:
        config?.compactFallbackRatio != null && config.compactFallbackRatio >= 1
          ? config.compactFallbackRatio
          : 3,
      compactEngine:
        config?.compactEngine ??
        createCompactEngine({
          defaultProtectHead: config?.protectFirstN ?? 5,
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
   * 使用 SmartRouter 进行智能路由决策（Q2 B′ 后两路由）：
   * - fits: 不需要压缩
   * - compact: 走 compact 能力（有 summarize 出真摘要；无 summarize / 失败走机械降级阶梯）
   */
  async assemble(params: AssembleParams): Promise<AssembleResult> {
    const {
      sessionId,
      agentId,
      messages,
      systemPrompt,
      tools,
      contextWindow,
      maxOutputTokens,
      compactTargetTokens,
      signal,
      tokenEstimator,
      summarize,
      taskSnapshot,
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

    // 进程重启后从持久层恢复压缩状态（仅当内存态完全没有压缩态时）。
    // 「有计数无摘要」（机械降级轮后）也是压缩态：若只看 previousSummary，降级轮之后
    // 每个 turn 都会重跑恢复、用持久化值覆盖内存里的增长门基数/覆盖终点（F8R-08）。
    if (loadCompactState) {
      const existing = this.states.get(stateKey);
      if (!existing?.previousSummary && existing?.lastProactiveMessageCount == null) {
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
    // targetTokens=0：只挂窗口比例线（proactiveCompactRatio）；该模式窗口未知时跳过 proactive。
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
              taskSnapshot,
              estimator,
              emit,
              systemPrompt,
              tools,
              contextWindow,
              maxOutputTokens,
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
    //    不变量：inputLimit + outputReserve ≤ effectiveLimit；强制点一律用 messagesLimit。
    const tokenBudgetForAlloc = budgetCap;
    const systemPromptTokensForAlloc = estimator.estimateText(systemPrompt);
    const toolTokensForAlloc = estimator.estimateTools(tools);
    const budget = this.config.budgetAllocator.allocate({
      tokenBudget: tokenBudgetForAlloc,
      contextWindow,
      maxOutputTokens: params.maxOutputTokens,
      systemPromptTokens: systemPromptTokensForAlloc,
      toolTokens: toolTokensForAlloc,
    });

    // 不变量不可满足（窗口连 system + tools + 输出预留都放不下）：
    // 这是配置问题，不在这里 fail-loud——8k 窗口 + 大 persona 是真实存在的部署，
    // 直接抛错会让每次 turn 都崩。改为用最小可运行预算继续，并由 `infeasible`
    // 如实标记（自定义 allocator / 上层可据此告警）；真实越界仍由 provider 拒绝暴露。
    const effectiveMessagesLimit = budget.infeasible ? 1000 : budget.messagesLimit;

    // 1b. 主动摘要：仅在有预算时启用（基于窗口/显式 target 的自动压缩）
    const proactive = await this.applyProactiveCompact({
      sessionId,
      stateKey,
      messages,
      messagesBudget: budget.messagesBudget,
      agingPlan,
      summarize,
      taskSnapshot,
      estimator,
      emit,
      systemPrompt,
      tools,
      contextWindow,
      maxOutputTokens,
    });
    const workingMessages = proactive.messages;
    const proactiveDroppedSummary = proactive.droppedSummary;

    // 2. 四区域消息选择（MessageSelector）
    //    强制点用 messagesLimit（硬）：叠加输出预留后的真实输入上限，
    //    不是压缩策略的软目标 messagesBudget。
    //    尺子与作用域同源：切分按原文（overflow 必须吃原文摘要，F-b），
    //    但**度量按老化视图**——实际请求发的是老化后的体量；量原文会让老化
    //    越有效越容易误判溢出，进而每请求触发一次溢出摘要（前缀缓存杀手）。
    const measureMessages = applyAgingToMessages(
      workingMessages,
      agingPlan,
      this.config.historyAging,
    );
    const selection = this.config.messageSelector.select(
      workingMessages,
      {
        maxTokens: effectiveMessagesLimit,
        protectFirstN: this.config.protectFirstN,
        protectLastN: this.config.protectLastN,
        measureMessages:
          measureMessages === workingMessages ? undefined : measureMessages,
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
    //    SmartRouter 只负责 fits/compact 判定，不负责判断是否需要压缩；
    //    摘要 vs 机械由 compact 能力按「有 summarize 就出真摘要」决定（B′）
    const overflowTokens = estimator.estimateMessages(selection.overflow);
    const routing = this.router.evaluate(selection.overflow, 0);

    // 5. 压缩溢出消息
    const state = this.states.get(stateKey);
    const previousSummary = state?.previousSummary;

    let compressedOverflow: Message[];
    let droppedSummary: string | undefined;
    let overflowFresh = false;
    let overflowSummary: string | undefined;
    // 是否真正发起过摘要 LLM 调用（成功/失败均算）——只有发起过才推进冷却时间戳
    let overflowSummarizeAttempted = false;

    // 计算溢出部分的压缩目标：head + selectedMiddle + tail 已占的 token
    // selection.estimatedTokens = head + selectedMiddle + tail 的 token 数
    // 压缩后 overflow 应使总 token 在预算内
    const keptTokens = selection.estimatedTokens;
    const overflowTargetTokens = Math.max(500, effectiveMessagesLimit - keptTokens);
    // 压缩无用判据：受保护的头尾本身就超预算时，中间段怎么压都无法让视图回到预算内
    // （MessageSelector 已在 kept 里按预算截断尾部）。此时再花一次 LLM 摘要不会改善
    // 任何东西，只会让这种「结构性超预算」配置每轮打一次 LLM（实测形态）。
    // 走机械账本降级并保持零 LLM。
    const protectedHeadTokens = estimator.estimateMessages(
      workingMessages.slice(0, Math.min(this.config.protectFirstN, workingMessages.length)),
    );
    const compactionCannotHelp =
      protectedHeadTokens + selection.tailTokens >= effectiveMessagesLimit;
    // overflow 也必须守 proactive 的同一套纪律（增长门 + 冷却）：它是安全网，
    // 不是「每轮增量摘要器」。缺了这两道门时，任何「受保护尾部接近预算」的会话
    // 都会每轮打一次 LLM 摘要（实测形态：冷却期内仍重打、视图永不收敛）。
    // 命中时改为机械账本降级——体积足够小，请求仍能通过；摘要留给下一个 turn 边界。
    const overflowLastCount = state?.lastProactiveMessageCount;
    const overflowNewSinceLast =
      overflowLastCount === undefined ? messages.length : messages.length - overflowLastCount;
    const overflowMinNew = Math.max(3, Math.floor(this.config.protectLastN * 0.25));
    const overflowCooldownMs = this.config.proactiveCooldownMs;
    const overflowInCooldown =
      overflowCooldownMs > 0 &&
      state?.lastProactiveLlmAt != null &&
      Date.now() - state.lastProactiveLlmAt < overflowCooldownMs;
    const skipLlmCompaction =
      compactionCannotHelp || overflowInCooldown || overflowNewSinceLast < overflowMinNew;
    const overflowStart = Date.now();
    const overflowTokensBefore = overflowTokens;
    emit?.({
      type: 'context.compact.start',
      sessionId,
      reason: 'overflow',
      tokensBefore: overflowTokensBefore,
    });

    try {
      // 缓存前缀：本轮会话同形 system+history（与主动摘要同纪律）
      const overflowLlmPrefix = this.buildLlmMessages(
        workingMessages,
        systemPrompt,
        tools,
        agingPlan,
      );
      switch (skipLlmCompaction ? 'cannot_help' : routing.route) {
        // B′（2026-11-03 拍板）：溢出统一走真摘要（打码降为机械降级阶梯第一级，
        // 「只打码不摘要」路由已删——工具胖溢出也必须出交接摘要）
        case 'compact': {
          const outcome = await this.config.compactEngine.compactMessages(selection.overflow, {
            protectHead: 0,
            protectTail: 0,
            targetTokens: overflowTargetTokens,
            // 无 requireSummary 语义：保持既有短路——预算内不压缩（auto）
            mode: 'auto',
            previousSummary,
            summarizeFn: summarize,
            // 摘要素材只随摘要请求走：无 summarize 的机械降级不携带（评审 L1）
            taskSnapshot: summarize ? taskSnapshot : undefined,
            estimator,
            // F8 统一契约：预算/折叠区间/窗口/事件与 manual、proactive 同源
            summaryBudget: this.config.summaryBudget,
            foldRange: {
              replacedCount: selection.overflow.length,
              total: workingMessages.length,
              preservedTail: selection.tail.length,
            },
            contextWindow: params.contextWindow,
            maxOutputTokens: params.maxOutputTokens,
            onSummarizeFail: 'truncate',
            llmPrefix: overflowLlmPrefix,
            emit: emit
              ? (e) => {
                  if (e.type === 'compact.summarize_fallback') {
                    emit({
                      type: 'context.compact.summarize_fallback',
                      sessionId,
                      reason: 'overflow',
                      fallback: e.reason,
                      cached: e.cached,
                    });
                  }
                }
              : undefined,
          });
          overflowFresh =
            outcome.fresh === true &&
            Boolean(outcome.summary) &&
            !isMechanicalNotice(outcome.summary!);
          overflowSummarizeAttempted = outcome.summarizeAttempted === true;
          overflowSummary = outcome.summary;
          compressedOverflow = Array.isArray(outcome.view) ? outcome.view : selection.overflow;
          droppedSummary = outcome.droppedSummary;
          break;
        }

        default: {
          // 兜底：账本截断（统一截断兜底，禁止只留 4 条）
          compressedOverflow = ledgerTruncate(selection.overflow, {
            targetTokens: overflowTargetTokens,
            estimator,
          }).result;
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
      // 压缩失败：账本截断降级，不中断本轮
      compressedOverflow = ledgerTruncate(selection.overflow, {
        targetTokens: overflowTargetTokens,
        estimator,
      }).result;
      droppedSummary = 'Context compact failed; fell back to truncation';
      // 已尝试调用（无论失败在哪一步，冷却都应生效，防止每轮重试打爆）
      overflowSummarizeAttempted = Boolean(summarize);
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
    // 覆盖终点：overflow 里的消息本身是 `messages` 中的**同一批对象**（视图只做切片/引用），
    // 因此按对象恒等映射回原始下标即可——不能拿视图下标直接当原始下标（视图已含合成的
    // 摘要消息，且尾部保护窗与视图长度不同，下标空间不一致）。合成摘要消息映射不到原始
    // 下标（-1），自然不推进：它不代表任何原始区间。
    const rawIndexByMessage = new Map<Message, number>();
    for (let i = 0; i < messages.length; i++) rawIndexByMessage.set(messages[i], i);
    let overflowCoverEnd = overflowState?.lastProactiveCoverEnd ?? 0;
    for (const m of selection.overflow) {
      const idx = rawIndexByMessage.get(m);
      if (idx !== undefined && idx + 1 > overflowCoverEnd) overflowCoverEnd = idx + 1;
    }
    // fresh 门控（评审 F8-F1）：机械降级/失败产出不得冒充新摘要推进 previousSummary；
    // 覆盖终点同理只在 fresh 时推进，且单调不减（不得回退到更早的覆盖点）。
    //
    // **不推进** lastProactiveMessageCount / lastProactiveFullTokens：这两个字段是
    // proactive 增长门的基准。overflow 每轮都会发生，若随之推进，`newSinceLast` 恒为 0、
    // 全量口径也不增长 → 真摘要再也不触发（实测：复用轮把 30 推成 31，增长门被饿死）。
    // overflow 的重复调用由冷却与增量门单独兜住，与增长门正交。
    this.states.set(stateKey, {
      ...overflowState,
      // 存摘要正文（而非 dropped 描述），供下次迭代更新
      previousSummary: overflowFresh
        ? overflowSummary ?? overflowState?.previousSummary
        : overflowState?.previousSummary,
      ...(overflowFresh ? { lastProactiveCoverEnd: overflowCoverEnd } : {}),
      // 只在真正发起过摘要调用时推进冷却（成功/失败均算发起）
      lastProactiveLlmAt: overflowSummarizeAttempted
        ? Date.now()
        : overflowState?.lastProactiveLlmAt,
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
   * 主动压缩（路径 A）：消息 token 超过触发线时，在硬溢出前收缩
   *
   * 触发线取两条线的 min（都保留，缺一不可）：
   * - **目标线** targetTokens × compactFallbackRatio——与窗口解耦，防长会话失忆
   * - **窗口比例线** messagesBudget × proactiveCompactRatio——防小窗口/已知窗口到顶仍未触发
   *
   * 语义（粘滞 + ratio=0 禁新压缩）：
   * - **压缩视图粘滞**：一旦建立过压缩态（previousSummary 或 lastProactiveMessageCount），
   *   后续装配优先复用 head+摘要/机械中间+tail，不因估算回落或 ratio=0 而打回全量
   *   （全量请求会 bust 前缀缓存，且等于撤销已完成的压缩）。
   * - **proactiveCompactRatio=0**：禁止**发起新的**路径 A 压缩（不只禁 LLM）；
   *   **不**丢弃已有压缩视图。
   * - 策略：
   *   - ratio=0：无压缩态原样返回；有压缩态仅粘滞重建
   *   - 未超线且无压缩态：原样返回
   *   - 超线且需要新一轮压缩（上次压缩后新增消息够多）：LLM 压缩中间段并产出语义摘要
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
    /** 交接式摘要素材（F8R-05）：自动路径随摘要请求透传，不再依赖历史里的旧快照副本 */
    taskSnapshot?: string;
    estimator: TokenEstimator;
    emit?: ContextEmitFn;
    /** 缓存前缀原料：与会话请求同形（system+tools+完整历史） */
    systemPrompt: string;
    tools: LLMToolDefinition[];
    /** 会话模型窗口（评审 F5）：摘要硬顶按窗口钳制 */
    contextWindow?: number;
    /** 模型 max_output_tokens（F8R-04）：自动路径摘要硬顶按输出上限钳制 */
    maxOutputTokens?: number;
  }): Promise<{ messages: Message[]; droppedSummary?: string }> {
    const {
      sessionId,
      messages,
      messagesBudget,
      agingPlan,
      summarize,
      estimator,
      emit,
      systemPrompt,
      tools,
    } = params;
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
    const { headEnd, tailStart } = alignViewSplit(messages, protectFirstN, protectLastN);
    const head = messages.slice(0, headEnd);
    const tail = messages.slice(tailStart);
    const middle = semanticHistory(messages.slice(headEnd, tailStart));

    // F1-B3（尺子与作用域同源）：预算度量必须量**老化视图**（实际请求的保守上界）。
    // 尺子量原文的老化前体量，会把 aging 的稳态误判超线（双机制打架）。
    // 注意：本引擎只度量、不执行降级——降级动作归 compact 能力。
    const agingView = applyAgingToMessages(messages, agingPlan, this.config.historyAging);
    const agingHead = agingView.slice(0, headEnd);
    const agingTail = agingView.slice(tailStart);

    const headTailTokens =
      estimator.estimateMessages(agingHead) + estimator.estimateMessages(agingTail);

    /**
     * 零 LLM 粘滞重建。
     *
     * 有语义摘要时：head + 摘要 + **摘要覆盖点之后的增量** + tail。
     * 增量（`lastProactiveCoverEnd` 之后、已滑出 tail 的消息）不得被旧摘要顶掉——
     * 否则长 tool turn 会丢当前 run 前半段工作记录。
     *
     * @returns 重建视图；无法重建时返回 null
     */
    const rebuildStickyView = async (): Promise<{ messages: Message[] } | null> => {
      if (messages.length <= protectFirstN + protectLastN) {
        return null;
      }
      if (state?.previousSummary) {
        const summaryMsg: Message = this.contextSummaryMessage(
          state.previousSummary,
          state.lastProactiveCoverEnd,
        );
        // 摘要覆盖到 lastProactiveCoverEnd（摘要/压缩实际覆盖的原始下标终点）；
        // 其后的消息是增量，必须保留
        const coverUpTo = state.lastProactiveCoverEnd ?? 0;
        const sinceIdx = Math.max(coverUpTo, headEnd);
        const sinceCompact = semanticHistory(messages.slice(sinceIdx, tailStart));
        // 增量原样保留（宁可胖，不可丢）：重建轮零 LLM 是产品红线，而机械降级
        // 在此处会把「每请求滑动 1 条」的边界写成 history 改写 → 前缀缓存整段报废。
        // 增量撑胖的后果由真正的守门人处理：MessageSelector 溢出 → overflow 摘要/
        // 账本兜底。装配层不越界执行压缩。
        return { messages: [...head, summaryMsg, ...sinceCompact, ...tail] };
      }
      if (middle.length === 0) {
        return null;
      }
      // 无摘要的粘滞重建：head + middle + tail 原样返回（不再做机械降级）。
      // 与增量分支同戒律——装配层的职责是「按压缩态重组视图」，不是执行压缩。
      // 早退条件（middle 已达标）也随之消失：既然不动 middle，就无需度量。
      return { messages: [...head, ...middle, ...tail] };
    };

    // F1-B3：尺子量**老化视图**（实际请求的保守上界）——raw 估算会把 B2 稳态误判超线（双机制打架）。
    // 压缩输入仍用原 messages（摘要质量需要原文）。
    const currentTokens = estimator.estimateMessages(agingView);

    // 两条触发线（都保留；刻意不用 legacy 命名，防被当成死代码清掉）：
    // - 目标线 targetLine = targetTokens × compactFallbackRatio：与窗口解耦（F1-B3），
    //   防长会话失忆；1M 窗口只挂比例线会永不触发。
    // - 窗口比例线 windowRatioLine = messagesBudget × proactiveCompactRatio：
    //   防小窗口（256k 等）在摸到目标线之前就顶满。
    // 窗口未知（messagesBudget=0）时比例线为 +∞，只用目标线。
    const targetLine = Math.ceil(this.config.targetTokens * this.config.compactFallbackRatio);
    const windowRatioLine =
      messagesBudget > 0 ? Math.floor(messagesBudget * ratio) : Number.POSITIVE_INFINITY;

    // ratio=0：禁止发起新的路径 A 压缩（不只禁 LLM）。已有粘滞视图仍重建，不打回全量。
    if (ratio <= 0) {
      if (!hasCompactView) {
        return { messages };
      }
      const sticky = await rebuildStickyView();
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

    // 触发线：目标线与窗口比例线取 min——小窗口走有门槛/冷却的温和 A，
    // 不被挤成死代码后交给无门槛的溢出路径每 turn 压缩（双机制打架换位置，评审 H1）。
    const threshold =
      this.config.targetTokens > 0 ? Math.min(targetLine, windowRatioLine) : windowRatioLine;

    const targetMiddleTokens = Math.max(
      200,
      Math.floor(threshold * 0.55) - headTailTokens,
    );

    // 新 LLM 压缩闸门（方案 E）：
    // - 无 summarize 或 turn 内：禁止新 LLM，不丢已有压缩态
    // - **turn 内**（最近真实 user 之后已有工具活动）：禁止新 LLM 摘要——
    //   活动工作记录在 middle 里，摘要会吃掉当前 run；只允许机械分级
    // - turn 边界（新 user 刚到、工具活动尚未开始）：才允许对更早历史做 LLM 摘要
    const midTurn = isMidTurn(messages);
    const allowNewLlmCompact = !!summarize && !midTurn;

    // 未超线：无压缩态则原样；有压缩态则粘滞重建（禁止回全量）
    if (currentTokens <= threshold) {
      if (!hasCompactView) {
        return { messages };
      }
      const sticky = await rebuildStickyView();
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
    // targetTokens=0（只挂窗口比例线）保持既有「攒够增量重试」节奏不动。
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
      const sticky = await rebuildStickyView();
      if (sticky) {
        const reducedTokens = estimator.estimateMessages(sticky.messages);
        // 只更新视图 token，**不要**改 lastProactiveMessageCount：
        // 该字段是「上次压缩轮（含机械降级）的全量条数」= 增长门基数 + 压缩态粘滞标记，
        // 仅在真实压缩轮结束时推进（不含复用重建）。若复用重建也改成 messages.length，
        // 每轮 +1 会永远凑不满再压缩阈值。
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

    // 禁新路径 A（无 summarize / turn 内）且无粘滞视图：超线也只走机械（不打摘要 LLM）
    if (!allowNewLlmCompact) {
      const sticky = await rebuildStickyView();
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

    let outcome: CompactOutcome;
    try {
      // 缓存前缀 = 会话同形 system+history（禁止改字节）；摘要指令只挂在尾部
      const llmPrefix = this.buildLlmMessages(messages, systemPrompt, tools, agingPlan);
      // requireSummary 语义 → mode 'structure_only'：机械截断达标也必须尝试摘要级
      // （'auto' 的 within_target 短路会以机械返回冒充已摘要——v0.83 requireSummary 反对的模式）
      outcome = await this.config.compactEngine.compactMessages(middle, {
        protectHead: 0,
        protectTail: 0,
        targetTokens: targetMiddleTokens,
        mode: 'structure_only',
        previousSummary: state?.previousSummary,
        summarizeFn: summarize,
        taskSnapshot: params.taskSnapshot,
        estimator,
        // F8 统一契约：预算/折叠区间与手动路径同源
        summaryBudget: this.config.summaryBudget,
        foldRange: {
          // 视图口径（与 manual 的 tailStart - headEnd 一致）：被替换的是 headEnd..tailStart
          // 整段；middle 是 semanticHistory 过滤后的条数，含 turn 元数据时会偏小
          replacedCount: tailStart - headEnd,
          total: messages.length,
          preservedTail: tail.length,
        },
        contextWindow: params.contextWindow,
        maxOutputTokens: params.maxOutputTokens,
        onSummarizeFail: 'truncate',
        llmPrefix,
        // F22：cache-miss 旁路透传可观测事件
        emit: emit
          ? (e) => {
              if (e.type === 'compact.summarize_fallback') {
                emit({
                  type: 'context.compact.summarize_fallback',
                  sessionId,
                  reason: 'proactive',
                  fallback: e.reason,
                  cached: e.cached,
                });
              }
            }
          : undefined,
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
      const sticky = await rebuildStickyView();
      return sticky ? { messages: sticky.messages } : { messages };
    }

    const body = Array.isArray(outcome.view) ? outcome.view : middle;
    const reduced = [...head, ...body, ...tail];
    const reducedTokens = estimator.estimateMessages(reduced);

    // fresh（评审 F8-F1）= 本次产出**新的**语义摘要；false 时旧摘要只作兜底：
    // 机械降级丢掉的中段不得被记成「已覆盖」（否则 rebuildStickyView 增量起点越过后它们永远
    // 回不到视图——静默失忆）：previousSummary 与覆盖终点只在 fresh 时推进（宁可胖不丢）。
    // isMechanicalNotice 兜底：机械占位永不冒充语义摘要。
    const fresh =
      outcome.fresh === true &&
      Boolean(outcome.summary) &&
      !isMechanicalNotice(outcome.summary!);
    this.states.set(stateKey, {
      ...state,
      previousSummary: fresh ? outcome.summary : state?.previousSummary,
      lastEstimatedTokens: reducedTokens,
      // 增长门计数随任何**完成的压缩轮**推进（含机械降级）——它是「自上次压缩新增条数」的
      // 基数与压缩态粘滞标记；若只随 fresh 推进，无摘要会话每轮被判全量新增、复用分支
      // 永远进不去（每 turn 重打 LLM）。「有计数无摘要」是生产状态形状（重启恢复快照
      // 即此形状）。覆盖终点语义不同：只随 fresh 推进（被丢的中段由 sticky 增量兜住）。
      lastProactiveMessageCount: messages.length,
      ...(fresh ? { lastProactiveCoverEnd: tailStart } : {}),
      lastProactiveTokens: reducedTokens,
      lastProactiveFullTokens: currentTokens,
      // 只在 LLM 摘要调用真正发起过时推进冷却时间戳（成功/失败均算发起，防打爆）；
      // 复用重建与未发起调用的机械降级不得推进此字段
      lastProactiveLlmAt: outcome.summarizeAttempted ? Date.now() : state?.lastProactiveLlmAt,
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
      droppedSummary: outcome.droppedSummary ?? 'Older turns proactively summarized',
    };
  }

  /**
   * 摘要消息构造（装配/度量共用）——包装/覆盖行渲染单源在 capabilities/compact/messages.ts，
   * 禁止在别处手抄此形状，防口径漂移
   */
  private contextSummaryMessage(summary: string, coveredEnd?: number): Message {
    return asSummaryMessage(summary, coveredEnd);
  }

  /**
   * 粘性视图布局 = head + 摘要 + tail（压缩后请求视图的唯一实现，装配与度量共用）
   *
   * @param messages - 全量原始消息
   * @param protectFirstN - 头部保护条数
   * @param protectLastN - 尾部保护条数
   * @param summary - 语义摘要正文
   * @returns 视图消息列表；总长 ≤ 头尾保护无需压缩时返回 null
   */
  private stickyViewMessages(
    messages: Message[],
    protectFirstN: number,
    protectLastN: number,
    summary: string,
    coveredEnd?: number,
    extra?: Message[],
  ): Message[] | null {
    if (messages.length <= protectFirstN + protectLastN) {
      return null;
    }
    // 边界对齐（不拆 tool_call/tool_result 对）：未对齐的 head/tail 会被严格网关 400
    const { headEnd, tailStart } = alignViewSplit(messages, protectFirstN, protectLastN);
    return [
      ...messages.slice(0, headEnd),
      this.contextSummaryMessage(summary, coveredEnd),
      // 增量位：覆盖点之后、尾部保护区之前的「摘要没覆盖、tailStart 又前移」区间，
      // 不显式保留会静默消失（评审 F12）。压缩时刻为空（coverEnd == tailStart），度量=装配不受影响
      ...(extra ?? []),
      ...messages.slice(tailStart),
    ];
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
    // 压缩时刻布局的唯一实现 stickyViewMessages（与 structuralCompact 的度量共用：度量=装配）。
    // 本函数服务「压缩后回放」：覆盖点（lastProactiveCoverEnd）到当前尾部保护区之间是**增量**
    // ——摘要没覆盖它们、tailStart 又随新消息前移，不显式保留会静默消失（评审 F12）。
    // rebuildStickyView 是带增量压缩的异步版布局；这里同步保留增量原文（宁可胖，不可丢）。
    const coverUpTo = state.lastProactiveCoverEnd ?? 0;
    const { headEnd, tailStart: viewTailStart } = alignViewSplit(
      messages,
      this.config.protectFirstN,
      this.config.protectLastN,
    );
    const increment = semanticHistory(
      messages.slice(Math.max(coverUpTo, headEnd), viewTailStart),
    );
    const viewMsgs = this.stickyViewMessages(
      messages,
      this.config.protectFirstN,
      this.config.protectLastN,
      summary,
      state.lastProactiveCoverEnd,
      increment,
    );
    if (!viewMsgs) {
      return { messages };
    }
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
      messages: viewMsgs,
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
    /** 缓存前缀：会话同形 system+history；有则摘要只尾部追加指令 */
    llmPrefix?: LLMMessage[];
    /** F22：cache-miss 旁路事件出口（manual 单发压缩的可观测性，与 proactive/overflow 对称） */
    emit?: ContextEmitFn;
    /** 同形前缀原料：systemPrompt 齐备且无现成 llmPrefix 时引擎内建（与 assemble 的 buildLlmMessages 同源） */
    systemPrompt?: string;
    tools?: LLMToolDefinition[];
    /** task 快照：交接式摘要指令尾部注入（B0 易变块走 content 尾部，不进 system） */
    taskSnapshot?: string;
    /** 会话模型窗口/输出上限（评审 F5）：摘要请求硬顶按窗口钳制，防最满时压缩被 400 */
    contextWindow?: number;
    maxOutputTokens?: number;
  }): Promise<CompactOutcome> {
    const { sessionId, messages, summarize, estimator } = params;
    // 同形前缀单源：优先调用方现成 llmPrefix；否则引擎内建。
    // system 字节取自会话托管 system 消息（source==='systemPrompt'）——它就是上一轮请求的逐字
    // system；重走 assembler 重建会有字节漂移（打穿缓存）。托管缺失时回落调用方 systemPrompt。
    // aging 计划与 assemble 同式（完整历史一次算好，见 assemble 处注释）——禁止手抄视图。
    const managedSystem = messages.find(
      (m) => m.role === 'system' && m.metadata?.source === 'systemPrompt',
    );
    const systemText =
      (managedSystem ? getTextContent(managedSystem.content) : '') || params.systemPrompt;
    const agingPlan = computeToolResultAgingPlan(messages, this.config.historyAging);
    const llmPrefix =
      params.llmPrefix ??
      (systemText ? this.buildLlmMessages(messages, systemText, params.tools ?? [], agingPlan) : undefined);
    const stateKey = params.stateKey ?? sessionId;
    const protectFirstN = this.config.protectFirstN;
    const protectLastN = this.config.protectLastN;
    const tokensBefore = estimator.estimateMessages(messages);
    const state = this.states.get(stateKey);

    if (messages.length <= protectFirstN + protectLastN) {
      return {
        ok: true,
        summary: state?.previousSummary,
        compacted: false,
        reason: 'too_short',
        tokensBefore,
        tokensAfter: tokensBefore,
        coveredMessageCount: state?.lastProactiveCoverEnd,
        fresh: false,
        summarizeAttempted: false,
        view: messages,
      };
    }

    // 覆盖坐标与 applyProactiveCompact / rebuildStickyView 同一系：
    // 原始 messages 上 alignViewSplit → middle 语义历史 → 摘要；coverEnd = tailStart。
    // 禁止对 semanticHistory(全量) 切 protectHead/Tail（过滤数组下标 ≠ 原始下标，会丢消息）。
    const { headEnd, tailStart } = alignViewSplit(messages, protectFirstN, protectLastN);
    const middle = semanticHistory(messages.slice(headEnd, tailStart));

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
        // 软目标预算（P1c clamp(2%,2k,8k)）交 compactCore 公式；可配置 ratio/min/max 经 summaryBudget
        summaryBudget: this.config.summaryBudget,
        taskSnapshot: params.taskSnapshot,
        // 折叠区间（评审 F7）：摘要器须覆盖 middle 区间、不总结原样保留的尾部
        foldRange: {
          replacedCount: tailStart - headEnd,
          total: messages.length,
          preservedTail: messages.length - tailStart,
        },
        contextWindow: params.contextWindow,
        maxOutputTokens: params.maxOutputTokens,
        onSummarizeFail: 'truncate',
        llmPrefix,
        // F8R-06：manual 路 cache-miss 旁路同样可观测（no_prefix/window_guard/window_exhausted）
        emit: params.emit
          ? (e) =>
              params.emit!({
                type: 'context.compact.summarize_fallback',
                sessionId: params.sessionId,
                fallback: e.reason,
                cached: e.cached,
              })
          : undefined,
      },
    );

    // fresh（评审 F1）= 本次产出**新的**语义摘要。false 时 outcome.summary 只是旧摘要兜底：
    // 不得推进覆盖点/覆盖计数（否则被丢弃的中段记成「已覆盖」，rebuildStickyView 的增量起点
    // 越过后它们永远回不到视图），也不得给旧摘要再叠 [Coverage]（F11：覆盖行随失败累积）。
    const fresh =
      outcome.fresh === true &&
      Boolean(outcome.summary) &&
      !isMechanicalNotice(outcome.summary!);

    if (!fresh) {
      // 失败语义（F9/F10）：状态不推进（增长门/冷却不被失败重置），报数不虚降（tokensAfter
      // = tokensBefore），compacted=false + reason 显式上报。宁可胖不丢：中段原文仍在视图
      // （覆盖点未动），等下次成功摘要再折叠。
      return {
        ok: true,
        summary: state?.previousSummary,
        compacted: false,
        reason: outcome.reason?.startsWith('summarize_failed')
          ? outcome.reason
          : `summarize_failed:${outcome.reason ?? 'no_output'}`,
        tokensBefore,
        tokensAfter: tokensBefore,
        coveredMessageCount: state?.lastProactiveCoverEnd,
        fresh: false,
        summarizeAttempted: outcome.summarizeAttempted,
        // 宁可胖不丢：中段原文仍在视图（覆盖点未动）
        view: messages,
      };
    }

    const summary = outcome.summary!;
    // [Coverage] 覆盖行不写进 previousSummary（F11：会把过期数字烘进摘要文本、随失败累积、
    // 还会被当 Previous summary 回喂）——由 contextSummaryMessage 在装配/度量时按覆盖点动态
    // 渲染；两处同一渲染器，度量=装配严格同形。
    const viewMsgs = this.stickyViewMessages(
      messages,
      protectFirstN,
      protectLastN,
      summary,
      tailStart,
    );
    // fresh 路径 middle 非空必有视图；兜底回 tokensBefore（不虚报）
    const tokensAfter = viewMsgs ? estimator.estimateMessages(viewMsgs) : tokensBefore;

    this.states.set(stateKey, {
      ...state,
      previousSummary: summary,
      lastProactiveMessageCount: messages.length,
      lastProactiveCoverEnd: tailStart,
      lastProactiveTokens: tokensAfter,
      // 校准基只写「实际请求」口径（见 assemble 处注释）：此处不量请求，故不写 lastEstimatedTokens
      lastProactiveLlmAt: outcome.summarizeAttempted ? Date.now() : state?.lastProactiveLlmAt,
    });

    return {
      ok: true,
      summary,
      compacted: true,
      tokensBefore,
      tokensAfter,
      coveredMessageCount: tailStart,
      fresh: true,
      summarizeAttempted: outcome.summarizeAttempted,
      coverage: outcome.coverage,
      // 度量=装配严格同形：返还是摘要落位后的 sticky 视图（与 tokensAfter 同源）
      view: viewMsgs ?? messages,
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
    /** 缓存前缀：会话同形 system+history */
    llmPrefix?: LLMMessage[];
    /** 同形前缀原料：与会话请求同源的 systemPrompt（tools 文档随 system 文本）；无 llmPrefix 时引擎内建 */
    systemPrompt?: string;
    tools?: LLMToolDefinition[];
    /** task 快照：交接式摘要指令尾部注入 */
    taskSnapshot?: string;
    /** 会话模型窗口/输出上限（评审 F5）：摘要请求硬顶按窗口钳制 */
    contextWindow?: number;
    maxOutputTokens?: number;
    /** F22：cache-miss 旁路事件出口（manual 路可观测性，与 proactive/overflow 对称） */
    emit?: ContextEmitFn;
  }): Promise<CompactOutcome> {
    const estimator = this.config.tokenEstimator;
    const stateKey = compactStateKey(input.sessionId, input.agentId);
    const result = await this.structuralCompact({
      sessionId: input.sessionId,
      stateKey,
      messages: input.messages,
      summarize: input.summarize,
      estimator,
      compactTargetTokens: input.compactTargetTokens,
      llmPrefix: input.llmPrefix,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      taskSnapshot: input.taskSnapshot,
      contextWindow: input.contextWindow,
      maxOutputTokens: input.maxOutputTokens,
      emit: input.emit,
    });
    return {
      ...result,
      ok: true,
      // 失败语义如实透传（评审 F10）：summarize_failed:* 不得被 'structural' 盖成成功。
      // 有意决定（P3 评审 F3）：manual 对外词汇固定为 'structural'（历史 API 词汇，
      // UI/测试沿用）；内层 reason（structure_only 等）不透传，避免对外词汇漂移
      reason: result.reason ?? 'structural',
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
  async afterStep(params: AfterStepParams): Promise<void> {
    const { sessionId, agentId, usage, step } = params;

    if (!usage) return;

    const stateKey = compactStateKey(sessionId, agentId);
    const state = this.states.get(stateKey) ?? {};

    // 存储真实 token 数（provider 报告 prompt ≈ 当前上下文）
    const promptActual =
      usage.inputReportedTokens ??
      usage.inputUncachedTokens + usage.inputCachedTokens + usage.inputCacheWriteTokens;
    state.lastActualTokens = promptActual;

    // 记录消息数量快照（step 包含本步消息，估算时用 messages.length - step.length 得到之前的消息数）
    state.lastUsageMessageCount = step?.length ?? 0;

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
    // 唯一例外：runStopped 是引擎停止的审计/展示凭据，不是对话内容——
    // 它只进聊天回放（系统提示条），不回灌 LLM（否则每次停止都在上下文里留痕）。
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'system' && msg.metadata?.source === 'systemPrompt') {
        continue;
      }
      if (msg.metadata?.source === 'runStopped') {
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
      // F1-B2：与结果同步老化的参数降级为键值摘要（id/name 不动，arguments 仍是合法 JSON）
      result.push({
        role: 'assistant',
        content: getTextContent(msg.content) || null,
        tool_calls: msg.toolCalls.map(tc => {
          const args =
            aging && this.config.historyAging.ageToolArgs && aging.agedIds.has(tc.id)
              ? agedToolArgDigest(tc.name, tc.arguments, this.config.historyAging)
              : tc.arguments;
          return {
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(args),
            },
          };
        }),
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

    // schedule notify 便签：借 user 通道落库的机器留言，不得在 LLM 视图冒充
    // 人话——视图级包 <schedule_notice> 信封（宪法 Confusables；持久层/UI 保
    // 原文。信封是消息的纯函数，回放逐字节稳定，不破 E8 前缀缓存）。
    if (isScheduleNotice(msg)) {
      for (const lm of result) {
        // 转义闭标签防伪造突破信封；空便签不包（不把空消息变成非空）
        const wrapText = (text: string): string =>
          text.trim()
            ? `<schedule_notice>${text.replaceAll('</schedule_notice', '&lt;/schedule_notice')}</schedule_notice>`
            : text;
        if (typeof lm.content === 'string') {
          lm.content = wrapText(lm.content);
        } else if (Array.isArray(lm.content)) {
          const blocks = lm.content as Array<{ type?: string; text?: string }>;
          lm.content = blocks.map((block) =>
            block.type === 'text' && typeof block.text === 'string'
              ? { ...block, text: wrapText(block.text) }
              : block,
          ) as Array<{ type: string; [key: string]: unknown }>;
        }
      }
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
    // 「真实 user」收紧：agentId 归因的 user（appendCommandDiscourse）不重置边界，
    // 载体过滤走唯一谓词 isTurnAnchor
    if (msg.agentId) continue;
    if (!isTurnAnchor(msg)) continue;
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
