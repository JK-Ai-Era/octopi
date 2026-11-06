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
 * - **持久转换记录**（arch/context-size-accounting.md §10.18）：压缩产物是事实，
 *   不是临时视图。装配 = 原文 + 有效记录的确定性 fold（transform/fold）——没有
 *   游标、没有增量抢救；没被记录覆盖的消息逐字在视图里。回填只在显式撤销时。
 * - fresh 门控只决定**新记录的类型**（summary / degrade），不再决定旧记录是否生效。
 * - 四区域划分（头部保护 + 中间可压缩 + 尾部保护）退为压缩时刻的选段策略：
 *   保护窗决定记录覆盖哪些消息（写进锚点），装配不再看它们。
 * - 边界对齐（不拆分 tool_call/tool_result 对）——同上，压缩时刻生效。
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
import { ContextSizeLedger } from './context-size-ledger.js';
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
import { HookedCompactEngine } from '../extension/plugin-ecosystem/hooks/compaction-integration.js';
import { isTurnAnchor, isScheduleNotice } from './layer-types.js';
import { createCompactEngine } from './capabilities/compact/index.js';
import type { CompactEngine, CompactOutcome } from './capabilities/compact/index.js';
import {
  alignViewSplit,
  isMechanicalNotice,
  ledgerTruncate,
  semanticHistory,
} from './capabilities/compact/index.js';
import { anchorRange } from './transform/anchors.js';
import { foldTransformView } from './transform/fold.js';
import type { FoldResult } from './transform/fold.js';
import { legacySnapshotToRecords } from './transform/migrate.js';
import type {
  NewTransformRecord,
  TransformLedger,
  TransformRecord,
  TransformRun,
  TransformStore,
} from './transform/types.js';
import { InMemoryTransformStore } from '../session/transform-store.js';

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
  /** 头部保护消息数（默认 5：交接快照的「任务前因」）。压缩时刻的选段策略。 */
  protectFirstN?: number;
  /** 尾部保护消息数（默认 20：进度锚，明确任务截止到哪）。压缩时刻的选段策略。 */
  protectLastN?: number;
  /** 摘要软目标预算（P1c 缺省 clamp(2%, 2k, 8k)）：可配置 ratioPct/minTokens/maxTokens */
  summaryBudget?: { ratioPct?: number; minTokens?: number; maxTokens?: number };
  /**
   * 窗口比例线：消息 token / messagesBudget 超过该比例时，
   * 在窗口硬溢出之前先做主动压缩（缓解长会话失忆 / 窗口到顶未触发）。
   * 默认 0.6；`0` = 禁止**发起新的**路径 A 压缩（不只禁 LLM），不丢已有转换记录。
   */
  proactiveCompactRatio?: number;
  /** 主动 LLM 摘要冷却（ms）。冷却期内零 LLM 复用（fold），避免单 turn 双摘要。默认 30_000。 */
  proactiveCooldownMs?: number;
  /**
   * 历史工具结果批量冻结老化（F1-B2）：当前 run 永不老化、近 rawWindow 条跨轮原文、
   * 更旧按 freezeBatch 成批降级为结构化指针（视图级、write-once、禁渐进）。
   * 缺省启用（40 条 / 批 20 / 指针 400 字符）。
   */
  historyAging?: ToolResultAgingConfig;
  /** 工作目标 token（与窗口解耦，F1-B3）。>0 时主动压缩目标线 = targetTokens × compactFallbackRatio。默认 200000。 */
  targetTokens?: number;
  /** 目标线倍数（默认 3）。触发线 = targetTokens × compactFallbackRatio；窗口比例线始终并存。 */
  compactFallbackRatio?: number;
  /** 公用能力 CompactEngine（缺省自动创建；算法委托，记录/状态仍在本引擎） */
  compactEngine?: CompactEngine;
  /**
   * 转换记录存储（持久化拍板：记录跨装配永久生效）。缺省 InMemory（进程内永久）；
   * 组合层注入 JsonlTransformStore 获得 `sessions/<sid>/transform/` 持久化。
   */
  transformStore?: TransformStore;
  /** Host extension boundary; absent preserves the existing engine exactly. */
  extensionHooks?: import('../extension/plugin-ecosystem/hooks/types.js').ExtensionHookPort;
  extensionIdentity?: { sessionId: string; agentId?: string };
}

// ── 内部状态 ──

/**
 * 引擎运行态。**压缩覆盖/摘要正文归转换记录账本**（单一事实源）；这里只留
 * 决策状态：校准配对（lastEstimatedTokens/modelKey/lastUsageAnchor）与增长门/
 * 冷却基数（记录生成时推进，重启从账本 meta 恢复）。
 */
interface CompactState {
  /** 上次估算 token 数（**恒为「system+tools+视图」请求口径的未校准估算**——P1-a 校准
   *  分母；只允许请求口径写点写入（assemble 的三个出口），compact 路径的 messages-only
   *  值不得写入，否则 calibrationRatio 被口径错位结构性抬高） */
  lastEstimatedTokens?: number;
  /** 上次 assemble 的 provider/model 标识（P1-a 校准 ratio 分键，与 lastEstimatedTokens 同槽配对） */
  modelKey?: string;
  /** 降级 B 锚（arch §10.16，评审 F3 原子对）：{实测 prompt, 同请求未校准估算, modelKey} 冻结写入 */
  lastUsageAnchor?: { actual: number; raw: number; modelKey: string };
  /** 上次压缩轮的全量条数（再压缩增长门 newSinceLast 基数；随任何完成的压缩轮推进） */
  lastProactiveMessageCount?: number;
  /** 上次压缩轮后的视图 token 估算（展示/恢复用） */
  lastProactiveTokens?: number;
  /** 上次真正发起 LLM 摘要调用的时间戳（冷却） */
  lastProactiveLlmAt?: number;
  /** 上次 LLM 压缩时的全量口径 token（再压缩增长门基准） */
  lastProactiveFullTokens?: number;
}

// ── 引擎实现 ──

export class DefaultContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: 'default',
    name: 'Default Context Engine',
  };

  private config: Required<Omit<
    DefaultContextEngineConfig,
    'compactEngine' | 'historyAging' | 'extensionHooks' | 'extensionIdentity' | 'transformStore'
  >> & {
    compactEngine: CompactEngine;
    historyAging: ToolResultAgingOptions;
    transformStore: TransformStore;
  };
  private router: SmartRouter;
  private states: Map<string, CompactState> = new Map();
  /** 转换记录账本缓存（每 (sessionId, agentId) 加载一次；append 同步进缓存） */
  private ledgers: Map<string, TransformLedger> = new Map();
  /** 孤儿记录告警去重（键：session|agent|seq[|partial]） */
  private orphanWarned = new Set<string>();
  /** P1-a 校准台账：ratio 按 model 分键，observe/calibrate 唯一出入口 */
  private sizeLedger = new ContextSizeLedger();

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
      transformStore: config?.transformStore ?? new InMemoryTransformStore(),
      compactEngine: (() => {
        const engine = config?.compactEngine ?? createCompactEngine({
          defaultProtectHead: config?.protectFirstN ?? 5,
          defaultProtectTail: config?.protectLastN ?? 20,
          estimator: {
            estimateMessages: (m) => tokenEstimator.estimateMessages(m),
            estimateText: (t) => tokenEstimator.estimateText(t),
          },
        });
        if (!config?.extensionHooks) return engine;
        return new HookedCompactEngine(engine, config.extensionHooks, config.extensionIdentity ?? { sessionId: 'default' });
      })(),
    };

    this.router = new SmartRouter({
      ...this.config.router,
      tokenEstimator,
    });
  }

  /**
   * 组装上下文
   *
   * 核心方法。装配 = 原文 + 有效转换记录的确定性 fold；需要收缩时由
   * proactive/overflow 路径产出新记录（记录先落盘、后发视图）。
   *
   * 路由（Q2 B′ 后两路由）：
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
      tokenEstimator,
      summarize,
      taskSnapshot,
      emit,
      loadCompactState,
    } = params;
    // E4：引擎内部状态键 = (sessionId, agentId)
    const stateKey = compactStateKey(sessionId, agentId);
    const ledger = await this.loadLedger(sessionId, agentId, messages, loadCompactState);
    this.restoreGatesFromLedger(stateKey, ledger);

    // F1-B2：老化计划基于**完整历史**（append-only）一次算好、随视图复用。
    // 估算（estimateLLMMessages）作用于老化后的 LLM 视图，尺子与实际请求一致。
    const agingPlan = computeToolResultAgingPlan(messages, this.config.historyAging);

    // 窗口未知且无显式 compactTargetTokens：跳过基于预算的自动压缩/截断
    const budgetCap = params.tokenBudget ?? contextWindow ?? compactTargetTokens;
    const windowKnown = contextWindow != null && contextWindow > 0;
    const targetKnown = compactTargetTokens != null && compactTargetTokens > 0;

    // P1-a（R1）：决策读数一律校准——estimator 参数流读到的都是校准值；原始估算只供
    // 校准分母（state.lastEstimatedTokens，「system+tools+视图」请求口径）。
    const rawEstimator = tokenEstimator ?? this.config.tokenEstimator;
    const modelKey = params.modelKey ?? 'unknown';
    const estimator = this.sizeLedger.calibratedEstimator(modelKey, rawEstimator);

    // 装配唯一实现：fold（原文 + 有效记录的确定性应用）
    let folded = this.foldView(messages, ledger);

    // 未知窗口：无 token 预算 → 不按 budget 截消息。
    // F1-B3：targetTokens>0 时兜底压缩与窗口无关，窗口未知照样执行（工作目标解耦）。
    if (!windowKnown && !targetKnown && budgetCap == null) {
      const proactive =
        this.config.targetTokens > 0
          ? await this.applyProactiveCompact({
              sessionId,
              agentId,
              stateKey,
              messages,
              ledger,
              messagesBudget: 0,
              agingPlan,
              summarize,
              taskSnapshot,
              estimator,
              rawEstimator,
              emit,
              systemPrompt,
              tools,
              contextWindow,
              maxOutputTokens,
            })
          : undefined;
      if (proactive) folded = proactive.fold;
      // 结构回放（复用轮）：记录生效但本轮零新压缩——cached 对不入会话流（既有语义）
      if (!proactive && folded.applied.some((r) => r.spans.length > 0)) {
        emit?.({ type: 'context.compact.start', sessionId, reason: 'proactive' });
        emit?.({
          type: 'context.compact.end',
          sessionId,
          reason: 'proactive',
          tokensBefore: 0,
          tokensAfter: 0,
          cached: true,
        });
      }
      const llmMessages = this.buildLlmMessages(folded.view, systemPrompt, tools, agingPlan);
      const rawEstimatedTokens = estimateLLMMessages(llmMessages) + rawEstimator.estimateTools(tools);
      const decision = this.sizeLedger.decisionTokensWithSource(
        modelKey,
        rawEstimatedTokens,
        this.states.get(stateKey)?.lastUsageAnchor,
      );
      this.states.set(stateKey, {
        ...this.states.get(stateKey),
        lastEstimatedTokens: rawEstimatedTokens,
        modelKey,
      });
      return {
        messages: llmMessages,
        estimatedTokens: decision.tokens,
        readingSource: decision.source,
        systemPrompt,
        droppedSummary:
          proactive?.droppedSummary ??
          (folded.applied.some((r) => r.spans.length > 0)
            ? 'Structural compact view (contextWindow unknown)'
            : undefined),
        summary: this.deriveSummary(ledger),
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
      agentId,
      stateKey,
      messages,
      ledger,
      messagesBudget: budget.messagesBudget,
      agingPlan,
      summarize,
      taskSnapshot,
      estimator,
      rawEstimator,
      emit,
      systemPrompt,
      tools,
      contextWindow,
      maxOutputTokens,
    });
    folded = proactive.fold;
    let view = proactive.view;
    const proactiveDroppedSummary = proactive.droppedSummary;

    // 2. 四区域消息选择（MessageSelector）
    //    强制点用 messagesLimit（硬）。尺子与作用域同源：切分按视图，度量按老化视图。
    const measureMessages = applyAgingToMessages(
      view,
      agingPlan,
      this.config.historyAging,
    );
    const selection = this.config.messageSelector.select(
      view,
      {
        maxTokens: effectiveMessagesLimit,
        protectFirstN: this.config.protectFirstN,
        protectLastN: this.config.protectLastN,
        measureMessages:
          measureMessages === view ? undefined : measureMessages,
      },
      estimator,
    );

    // 3. 如果没有溢出，不需要压缩
    if (selection.overflow.length === 0) {
      const llmMessages = this.buildLlmMessages(view, systemPrompt, tools, agingPlan);
      const rawEstimatedTokens = estimateLLMMessages(llmMessages) + rawEstimator.estimateTools(tools);
      const decision = this.sizeLedger.decisionTokensWithSource(
        modelKey,
        rawEstimatedTokens,
        this.states.get(stateKey)?.lastUsageAnchor,
      );

      this.states.set(stateKey, {
        ...this.states.get(stateKey),
        lastEstimatedTokens: rawEstimatedTokens,
        modelKey,
      });

      return {
        messages: llmMessages,
        estimatedTokens: decision.tokens,
        readingSource: decision.source,
        systemPrompt,
        droppedSummary: proactiveDroppedSummary,
        summary: this.deriveSummary(ledger),
      };
    }

    // 4. 有溢出：SmartRouter 决定压缩策略（fits/compact 判定；摘要 vs 机械由 compact 能力决定）
    const routing = this.router.evaluate(selection.overflow, 0, estimator);

    // 5. 压缩溢出消息（产物经 appendRecordFromProduct 转换为持久记录）
    const state = this.states.get(stateKey);
    const previousSummary = this.deriveSummary(ledger);

    let productView: Message[];
    let droppedSummary: string | undefined;
    let overflowFresh = false;
    let overflowSummary: string | undefined;
    // 是否真正发起过摘要 LLM 调用（成功/失败均算）——只有发起过才推进冷却时间戳
    let overflowSummarizeAttempted = false;

    // 计算溢出部分的压缩目标：head + selectedMiddle + tail 已占的 token
    const keptTokens = selection.estimatedTokens;
    const overflowTargetTokens = Math.max(500, effectiveMessagesLimit - keptTokens);
    // 压缩无用判据：受保护的头尾本身就超预算时，中间段怎么压都无法让视图回到预算内。
    // 走机械账本降级并保持零 LLM。
    const protectedHeadTokens = estimator.estimateMessages(
      view.slice(0, Math.min(this.config.protectFirstN, view.length)),
    );
    const compactionCannotHelp =
      protectedHeadTokens + selection.tailTokens >= effectiveMessagesLimit;
    // overflow 也必须守 proactive 的同一套纪律（增长门 + 冷却）：它是安全网，
    // 不是「每轮增量摘要器」。
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
    // 事件计量口径（P0-C M2）：compact 对 = messages-only 未校准、同一集合（全视图前后）。
    const compactTokensBefore = rawEstimator.estimateMessages(view);
    emit?.({
      type: 'context.compact.start',
      sessionId,
      reason: 'overflow',
      tokensBefore: compactTokensBefore,
    });

    try {
      // 缓存前缀：本轮会话同形 system+history（与主动摘要同纪律）
      const overflowLlmPrefix = this.buildLlmMessages(
        view,
        systemPrompt,
        tools,
        agingPlan,
      );
      switch (skipLlmCompaction ? 'cannot_help' : routing.route) {
        // B′（2026-11-03 拍板）：溢出统一走真摘要（打码降为机械降级阶梯第一级）
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
              total: view.length,
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
          if (outcome.reason?.startsWith('denied:')) {
            const reason = outcome.reason;
            // before_compaction 策略拒绝：摘要被否，但 veto 不得强迫发出超窗请求——
            // 与 summarize_failed 同姿势走机械截断兜底（after_compaction 不触发）。
            emit?.({
              type: 'context.compact.error', sessionId, reason: 'overflow', error: reason,
              kind: 'denied',
              durationMs: Date.now() - overflowStart,
            });
            productView = ledgerTruncate(selection.overflow, {
              targetTokens: overflowTargetTokens,
              estimator,
            }).result;
            droppedSummary = `${reason}; fell back to truncation`;
            overflowSummarizeAttempted = false;
            break;
          }
          overflowFresh =
            outcome.fresh === true &&
            Boolean(outcome.summary) &&
            !isMechanicalNotice(outcome.summary!);
          overflowSummarizeAttempted = outcome.summarizeAttempted === true;
          overflowSummary = outcome.summary;
          productView = Array.isArray(outcome.view) ? outcome.view : selection.overflow;
          droppedSummary = outcome.droppedSummary;
          break;
        }

        default: {
          // 兜底：账本截断（统一截断兜底，禁止只留 4 条）
          productView = ledgerTruncate(selection.overflow, {
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
      productView = ledgerTruncate(selection.overflow, {
        targetTokens: overflowTargetTokens,
        estimator,
      }).result;
      droppedSummary = 'Context compact failed; fell back to truncation';
      // 已尝试调用（无论失败在哪一步，冷却都应生效，防止每轮重试打爆）
      overflowSummarizeAttempted = Boolean(summarize);
    }

    // 6. 产物 → 持久转换记录（记录先落盘，视图后发）
    await this.appendRecordFromProduct({
      sessionId,
      agentId,
      messages,
      input: selection.overflow,
      productView,
      fold: folded,
      fresh: overflowFresh,
      summarizeAttempted: overflowSummarizeAttempted,
      reason: 'overflow',
      summaryText: overflowSummary,
      estimator,
    });
    // 7. 确定性重装配：fold 是唯一视图实现
    folded = this.foldView(messages, ledger);
    view = folded.view;

    // overflow 不推进增长门基数/全量口径（与既有语义一致：overflow 每轮都会发生，
    // 随之推进会饿死真摘要的增长门）；只在发起过摘要调用时推进冷却。
    this.states.set(stateKey, {
      ...state,
      lastProactiveLlmAt: overflowSummarizeAttempted
        ? Date.now()
        : state?.lastProactiveLlmAt,
    });

    emit?.({
      type: 'context.compact.end',
      sessionId,
      reason: 'overflow',
      tokensBefore: compactTokensBefore,
      tokensAfter: rawEstimator.estimateMessages(view),
      durationMs: Date.now() - overflowStart,
      cached: false,
    });

    // 8. 构建 LLM 消息（校准基 = 老化后 LLM 视图估算——尺子必须量实际请求）
    const llmMessages = this.buildLlmMessages(view, systemPrompt, tools, agingPlan);
    const rawEstimatedTokens = estimateLLMMessages(llmMessages) + rawEstimator.estimateTools(tools);
    const decision = this.sizeLedger.decisionTokensWithSource(
      modelKey,
      rawEstimatedTokens,
      this.states.get(stateKey)?.lastUsageAnchor,
    );
    this.states.set(stateKey, {
      ...this.states.get(stateKey),
      lastEstimatedTokens: rawEstimatedTokens,
      modelKey,
    });

    return {
      messages: llmMessages,
      estimatedTokens: decision.tokens,
      readingSource: decision.source,
      systemPrompt,
      droppedSummary: droppedSummary ?? proactiveDroppedSummary,
      summary: this.deriveSummary(ledger),
    };
  }

  // ── 转换记录账本 ──

  /**
   * 加载（并缓存）(sessionId, agentId) 的转换记录账本；账本为空且有旧压缩快照时
   * 一次性迁移（幂等：账本非空即跳过）。
   *
   * @param sessionId - 会话 id
   * @param agentId - agent id
   * @param messages - 全量原始消息（迁移锚点需要）
   * @param loadLegacy - 旧 ContextCompactSnapshot 读口（迁移输入；缺省不迁移）
   * @returns 账本
   */
  private async loadLedger(
    sessionId: string,
    agentId: string | undefined,
    messages: Message[],
    loadLegacy?: (sessionId: string) => Promise<ContextCompactSnapshot | undefined> | ContextCompactSnapshot | undefined,
  ): Promise<TransformLedger> {
    const stateKey = compactStateKey(sessionId, agentId);
    const cached = this.ledgers.get(stateKey);
    if (cached) return cached;
    const agent = agentId ?? '';
    let ledger = await this.config.transformStore.load(sessionId, agent);
    // 迁移幂等门 = 账本完全无条目（F7：行在 blob 全丢不算空——不得重放旧快照迁移）
    if (ledger.records.length === 0 && !ledger.hadEntries && loadLegacy) {
      const snapshot = await loadLegacy(sessionId);
      if (snapshot) {
        const records = legacySnapshotToRecords({
          sessionId,
          agentId: agent,
          snapshot,
          messages,
          protectFirstN: this.config.protectFirstN,
          protectLastN: this.config.protectLastN,
        });
        if (records && records.length > 0) {
          await this.config.transformStore.append(sessionId, agent, records);
          ledger = await this.config.transformStore.load(sessionId, agent);
        }
      }
    }
    this.ledgers.set(stateKey, ledger);
    return ledger;
  }

  /** 重 fold（append 后调用）；孤儿告警去重键 = session|agent|seq（F9：跨会话不串键） */
  private foldView(messages: Message[], ledger: TransformLedger): FoldResult {
    return foldTransformView(messages, ledger, {
      onOrphan: (record) => {
        const key = `${record.sessionId}|${record.agentId}|${record.seq}`;
        if (this.orphanWarned.has(key)) return;
        this.orphanWarned.add(key);
        console.warn(
          `[transform] session=${record.sessionId} agent=${record.agentId} record seq=${record.seq} orphaned (anchor unresolved); raw text stays visible`,
        );
      },
      onPartialOrphan: (record, droppedRuns) => {
        const key = `${record.sessionId}|${record.agentId}|${record.seq}|partial`;
        if (this.orphanWarned.has(key)) return;
        this.orphanWarned.add(key);
        console.warn(
          `[transform] session=${record.sessionId} agent=${record.agentId} record seq=${record.seq}: ${droppedRuns} run(s) orphaned (stream truncated?); surviving runs stay effective`,
        );
      },
    });
  }

  /**
   * 显式撤销一条转换记录（回填的唯一通道；记录模型拍板：「回填只在显式撤销时」）。
   *
   * 撤销是 append-only 附加行，永久生效面翻转为 revoked；被覆盖的原文在下一次
   * 装配回到视图。宿主（UI/工具）据此实现「撤销压缩」。
   *
   * @param sessionId - 会话 id
   * @param agentId - agent id
   * @param seq - 记录 seq（账本 load 可得）
   * @returns void
   */
  async revokeTransformRecord(sessionId: string, agentId: string | undefined, seq: number): Promise<void> {
    const agent = agentId ?? '';
    await this.config.transformStore.append(sessionId, agent, [], [seq]);
    // 缓存同步：revocation 立即生效（无需重载）
    const ledger = this.ledgers.get(compactStateKey(sessionId, agentId));
    const target = ledger?.records.find((r) => r.seq === seq);
    if (target) target.revoked = true;
  }

  /** 当前有效语义摘要正文（最新 summary 型记录的文本；机械占位永不冒充） */
  private deriveSummary(ledger: TransformLedger): string | undefined {
    for (let i = ledger.records.length - 1; i >= 0; i--) {
      const record = ledger.records[i]!;
      if (record.revoked || record.type !== 'summary') continue;
      if (record.text) return record.text;
    }
    return undefined;
  }

  /** 有效记录覆盖终点（下标，不含）——传输口径 coveredMessageCount 用 */
  private derivedCoverEnd(folded: FoldResult): number | undefined {
    let end: number | undefined;
    for (const run of folded.applied) {
      for (const [, b] of run.spans) {
        if (end === undefined || b + 1 > end) end = b + 1;
      }
    }
    return end;
  }

  /** 重启恢复：增长门/冷却基数从账本 meta 初始化（仅内存态缺失时；F2 对称） */
  private restoreGatesFromLedger(stateKey: string, ledger: TransformLedger): void {
    if (this.states.has(stateKey)) return;
    const effective = ledger.records.filter((r) => !r.revoked);
    // 门基只认非 overflow 记录——overflow 在进程内从不推进增长门（防饿死真摘要），
    // 重启恢复必须同口径（评审 F2：否则每次重启后增长门静默失效/被饿死）
    const gateBase = [...effective].reverse().find((r) => r.meta.reason !== 'overflow');
    const lastLlm = [...effective].reverse().find((r) => r.meta.summarizeAttempted);
    if (!gateBase && !lastLlm) return;
    this.states.set(stateKey, {
      ...(gateBase
        ? {
            lastProactiveMessageCount: gateBase.meta.messageCount,
            lastProactiveTokens: gateBase.meta.viewTokens,
            lastProactiveFullTokens: gateBase.meta.fullTokens,
          }
        : {}),
      lastProactiveLlmAt: lastLlm?.createdAt,
    });
  }

  /**
   * 压缩产物 → 持久转换记录（三条压缩路径的唯一翻译口）。
   *
   * 翻译 = 对照压缩输入与产物视图做身份差分：产物里消失的原文/占位所代表的原始
   * 区间即记录覆盖区间（contiguous 合并）。fresh 且为真摘要 → summary 型；否则
   * degrade 型（机械占位如实分类，伪摘要永不冒充 summary）。
   *
   * @param params - 输入集合、产物视图、fresh 判定等
   * @returns 生成的记录（无丢弃时为 undefined，不产记录）
   */
  private async appendRecordFromProduct(params: {
    sessionId: string;
    agentId: string | undefined;
    messages: Message[];
    /** 压缩输入项（原文或占位消息） */
    input: Message[];
    /** 压缩产物视图项 */
    productView: Message[];
    /** 产物翻译用的当前 fold（占位 → 记录区间） */
    fold: FoldResult;
    fresh: boolean;
    summarizeAttempted: boolean;
    reason: 'proactive' | 'overflow' | 'manual';
    /** fresh 语义摘要正文（有则 summary 型） */
    summaryText?: string;
    /** 全量口径 token 估算（增长门基数，随记录持久；overflow 轮不传） */
    fullTokens?: number;
    /** 视图 token 估算器（记录 meta 用） */
    estimator: TokenEstimator;
  }): Promise<TransformRecord | undefined> {
    const kept = new Set(params.productView);
    const rawIndex = new Map<Message, number>();
    for (let i = 0; i < params.messages.length; i++) rawIndex.set(params.messages[i]!, i);

    // 产物新增的合成消息（摘要/账本占位）——降级记录的文本来源
    const inputSet = new Set(params.input);
    const synthetic = params.productView.filter(
      (m) => !rawIndex.has(m) && !inputSet.has(m),
    );

    // F1（评审）：类型判定前置——degrade 记录的机械文本**不包含**被吞占位的语义内容，
    // 因此不得覆盖既有记录的区间（否则摘要从视图里静默消失）；只有 fresh 语义摘要
    // （经 previousSummary 合并）才允许接管既有记录的区间。
    const freshOk =
      params.fresh && Boolean(params.summaryText) && !isMechanicalNotice(params.summaryText!);

    const spans: Array<[number, number]> = [];
    for (const item of params.input) {
      if (kept.has(item)) continue;
      const idx = rawIndex.get(item);
      if (idx !== undefined) {
        spans.push([idx, idx]);
        continue;
      }
      // 占位项 = 既有记录的区间。degrade 不接管（见上）；summary 接管（合并语义）
      if (!freshOk) continue;
      const run = params.fold.placeholderOf.get(item);
      if (run) spans.push(...run.spans.map((s) => [s[0], s[1]] as [number, number]));
    }
    if (spans.length === 0) return undefined;

    // 合并连续/重叠区间 → 覆盖 run 集
    spans.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span[0] <= last[1] + 1) {
        last[1] = Math.max(last[1], span[1]);
      } else {
        merged.push([span[0], span[1]]);
      }
    }
    const covers: TransformRun[] = [];
    for (const [a, b] of merged) {
      const run = anchorRange(params.messages, a, b);
      if (run) covers.push(run);
    }
    if (covers.length === 0) return undefined;

    const syntheticText = synthetic
      .map((m) => getTextContent(m.content))
      .filter((t) => t.trim().length > 0)
      .join('\n\n');
    const text = freshOk
      ? params.summaryText!
      : syntheticText || `[Context truncated: ${merged.length} range(s) mechanically dropped]`;
    const syntheticSource = synthetic.find((m) => typeof m.metadata?.source === 'string')?.metadata
      ?.source as string | undefined;

    const record: NewTransformRecord = {
      sessionId: params.sessionId,
      agentId: params.agentId ?? '',
      type: freshOk ? 'summary' : 'degrade',
      createdAt: Date.now(),
      covers,
      text,
      placeholder: freshOk
        ? { role: 'user', source: 'contextSummary' }
        : { role: 'user', source: syntheticSource ?? 'contextLedger' },
      meta: {
        reason: params.reason,
        fresh: freshOk,
        summarizeAttempted: params.summarizeAttempted,
        messageCount: params.messages.length,
        // F2：全量口径基数必须随记录持久（重启后增长门不能静默失效）
        ...(params.fullTokens !== undefined ? { fullTokens: params.fullTokens } : {}),
      },
    };

    // 记录 meta 的视图估算：以「记录生效后的 fold」度量（度量=装配）
    const virtual: TransformLedger = {
      records: [
        ...this.ledgers.get(compactStateKey(params.sessionId, params.agentId))!.records,
        { ...record, seq: -1, blobRef: undefined, revoked: false },
      ],
    };
    const virtualFold = foldTransformView(params.messages, virtual, {});
    record.meta.viewTokens = params.estimator.estimateMessages(virtualFold.view);

    const [persisted] = await this.config.transformStore.append(
      params.sessionId,
      params.agentId ?? '',
      [record],
    );
    const ledger = this.ledgers.get(compactStateKey(params.sessionId, params.agentId));
    if (ledger && persisted) ledger.records.push(persisted);
    return persisted;
  }

  /**
   * 主动压缩（路径 A）：消息 token 超过触发线时，在硬溢出前收缩
   *
   * 触发线取两条线的 min：
   * - **目标线** targetTokens × compactFallbackRatio——与窗口解耦，防长会话失忆
   * - **窗口比例线** messagesBudget × proactiveCompactRatio——防小窗口到顶未触发
   *
   * 语义（记录模型）：
   * - 装配 = fold（原文 + 有效记录）；已有压缩态天然粘滞，不因估算回落打回全量
   * - proactiveCompactRatio=0：禁止发起**新的**压缩；已有记录照常生效
   * - 超线且需要新一轮压缩（增长门 + 冷却）：LLM 压缩中间段 → 产出 summary 记录
   * - 其余情形：零 LLM，直接返回 fold 视图
   */
  private async applyProactiveCompact(params: {
    sessionId: string;
    /** E4: compact key component; engine state key falls back to sessionId when omitted */
    agentId?: string;
    /** E4 engine state key; defaults to sessionId */
    stateKey?: string;
    messages: Message[];
    ledger: TransformLedger;
    messagesBudget: number;
    agingPlan: ToolResultAgingPlan;
    summarize?: SummarizeFunction;
    /** 交接式摘要素材（F8R-05）：自动路径随摘要请求透传 */
    taskSnapshot?: string;
    estimator: TokenEstimator;
    /** 事件计量用原始估算器（compact 对 = messages-only 未校准口径，P0-C M2） */
    rawEstimator: TokenEstimator;
    emit?: ContextEmitFn;
    /** 缓存前缀原料：与会话请求同形（system+tools+完整历史） */
    systemPrompt: string;
    tools: LLMToolDefinition[];
    /** 会话模型窗口（评审 F5）：摘要硬顶按窗口钳制 */
    contextWindow?: number;
    /** 模型 max_output_tokens（F8R-04）：自动路径摘要硬顶按输出上限钳制 */
    maxOutputTokens?: number;
  }): Promise<{ view: Message[]; fold: FoldResult; droppedSummary?: string }> {
    const {
      sessionId,
      messages,
      ledger,
      messagesBudget,
      agingPlan,
      summarize,
      estimator,
      rawEstimator,
      emit,
      systemPrompt,
      tools,
    } = params;
    const stateKey = params.stateKey ?? sessionId;
    const ratio = this.config.proactiveCompactRatio;
    const state = this.states.get(stateKey);

    let folded = this.foldView(messages, ledger);

    if (messages.length === 0) {
      return { view: folded.view, fold: folded };
    }

    const protectFirstN = this.config.protectFirstN;
    const protectLastN = this.config.protectLastN;

    // 压缩态标记：有有效记录即「已压缩」（含 gate-anchor / degrade）
    const hasCompactView = ledger.records.some((r) => !r.revoked);

    // 边界对齐（不拆 tool_call/tool_result 对）——两形状都会被严格网关 400。
    // 保护窗只决定**压缩选段**（记录覆盖哪些原文），装配由 fold 负责。
    const { headEnd, tailStart } = alignViewSplit(messages, protectFirstN, protectLastN);
    const middleRaw = messages.slice(headEnd, tailStart);
    const middle = semanticHistory(middleRaw); // 仅供 summarize 素材，禁止回装进视图

    // F1-B3（尺子与作用域同源）：触发线度量量**老化视图**（实际请求的保守上界）
    const agingView = applyAgingToMessages(messages, agingPlan, this.config.historyAging);
    const agingHead = agingView.slice(0, headEnd);
    const agingTail = agingView.slice(tailStart);

    const headTailTokens =
      estimator.estimateMessages(agingHead) + estimator.estimateMessages(agingTail);

    // F1-B3：尺子量**老化视图**——raw 估算会把 B2 稳态误判超线（双机制打架）。
    // 压缩输入仍用原 messages（摘要质量需要原文）。
    const currentTokens = estimator.estimateMessages(agingView);

    // 两条触发线（都保留；刻意不用 legacy 命名，防被当成死代码清掉）：
    const targetLine = Math.ceil(this.config.targetTokens * this.config.compactFallbackRatio);
    const windowRatioLine =
      messagesBudget > 0 ? Math.floor(messagesBudget * ratio) : Number.POSITIVE_INFINITY;

    // ratio=0：禁止发起新的路径 A 压缩（不只禁 LLM）。已有记录照常生效（fold）。
    if (ratio <= 0) {
      if (hasCompactView) {
        this.states.set(stateKey, {
          ...state,
          lastProactiveTokens: estimator.estimateMessages(folded.view),
        });
      }
      return { view: folded.view, fold: folded };
    }

    // 触发线：目标线与窗口比例线取 min。单位：比较双方都是**校准后** token 读数。
    // 数值：threshold = min(targetLine, windowRatioLine)（arch/context-size-accounting.md §5.2）。
    const threshold =
      this.config.targetTokens > 0 ? Math.min(targetLine, windowRatioLine) : windowRatioLine;

    const targetMiddleTokens = Math.max(
      200,
      Math.floor(threshold * 0.55) - headTailTokens,
    );

    // 新 LLM 压缩闸门（方案 E）：
    // - 无 summarize 或 turn 内：禁止新 LLM，不丢已有压缩态
    // - turn 边界（新 user 刚到、工具活动尚未开始）：才允许对更早历史做 LLM 摘要
    const midTurn = isMidTurn(messages);
    const allowNewLlmCompact = !!summarize && !midTurn;

    // 未超线：fold 视图（记录天然粘滞）
    if (currentTokens <= threshold) {
      if (hasCompactView) {
        this.states.set(stateKey, {
          ...state,
          lastProactiveTokens: estimator.estimateMessages(folded.view),
        });
      }
      return { view: folded.view, fold: folded };
    }

    if (messages.length <= protectFirstN + protectLastN) {
      return { view: folded.view, fold: folded };
    }

    // 判据：是否开启新一轮压缩 —— 只看「自上次压缩以来的新增条数」与冷却。
    const lastCount = state?.lastProactiveMessageCount;
    const newSinceLast = lastCount === undefined ? messages.length : messages.length - lastCount;
    const minNewForResummarize = Math.max(3, Math.floor(protectLastN * 0.25));
    // 增长门（target 模式；防「偶发兜底」变「周期压缩」）：只有全量口径较上次压缩
    // 实质增长（≥ 25% 阈值）才允许再打 LLM。
    const lastFull = state?.lastProactiveFullTokens;
    const grownEnough =
      this.config.targetTokens <= 0 ||
      lastFull === undefined ||
      currentTokens >= lastFull + Math.max(1, Math.floor(threshold * 0.25));
    const needNewCompaction = newSinceLast >= minNewForResummarize && grownEnough;

    // 冷却：刚做过 LLM 摘要则优先零 LLM 复用，降低单 turn 双摘要概率
    const cooldownMs = this.config.proactiveCooldownMs;
    const inCooldown =
      cooldownMs > 0 &&
      state?.lastProactiveLlmAt != null &&
      Date.now() - state.lastProactiveLlmAt < cooldownMs;

    // 复用重建（零 LLM）：已压缩过，且增量小或在冷却期或禁止新 LLM。
    // fold 即重建——记录是持久事实，复用不改任何状态（增长门基数不动）。
    if (hasCompactView && (!allowNewLlmCompact || !needNewCompaction || inCooldown)) {
      this.states.set(stateKey, {
        ...state,
        lastProactiveTokens: estimator.estimateMessages(folded.view),
      });
      // 复用重建 ≠ 压缩（2026-11-06 事故的 1ms「compacted」误报家族）：cached=true
      // 使 adapter 不入会话流（既有语义）；计量对 0/0（无新压缩计量）
      emit?.({
        type: 'context.compact.start',
        sessionId,
        reason: 'proactive',
        threshold,
      });
      emit?.({
        type: 'context.compact.end',
        sessionId,
        reason: 'proactive',
        tokensBefore: 0,
        tokensAfter: 0,
        durationMs: 0,
        cached: true,
      });
      return { view: folded.view, fold: folded };
    }

    // 禁新路径 A（无 summarize / turn 内）且无压缩态：超线也只走机械（不打摘要 LLM）
    if (!allowNewLlmCompact) {
      return { view: folded.view, fold: folded };
    }

    // 需要新一轮压缩：压缩 head/tail 之间的中间段（语义历史，不含 grounding）。
    if (middle.length === 0) {
      return { view: folded.view, fold: folded };
    }

    const proactiveStart = Date.now();
    // 事件计量口径同 overflow（P0-C M2）：messages-only 未校准、同集合前后对
    const compactTokensBefore = rawEstimator.estimateMessages(folded.view);
    emit?.({
      type: 'context.compact.start',
      sessionId,
      reason: 'proactive',
      tokensBefore: compactTokensBefore,
      threshold,
    });

    let outcome: CompactOutcome;
    try {
      // 缓存前缀 = 会话同形 system+history（禁止改字节）；摘要指令只挂在尾部
      const llmPrefix = this.buildLlmMessages(messages, systemPrompt, tools, agingPlan);
      // requireSummary 语义 → mode 'structure_only'：机械截断达标也必须尝试摘要级
      outcome = await this.config.compactEngine.compactMessages(middle, {
        protectHead: 0,
        protectTail: 0,
        targetTokens: targetMiddleTokens,
        mode: 'structure_only',
        previousSummary: this.deriveSummary(ledger),
        summarizeFn: summarize,
        taskSnapshot: params.taskSnapshot,
        estimator,
        // F8 统一契约：预算/折叠区间与手动路径同源
        summaryBudget: this.config.summaryBudget,
        foldRange: {
          // 视图口径（与 manual 的 tailStart - headEnd 一致）：被替换的是 headEnd..tailStart
          // 整段；summarize 素材是 semanticHistory 过滤后的条数，含 turn 元数据时会偏小
          replacedCount: tailStart - headEnd,
          total: messages.length,
          preservedTail: messages.length - tailStart,
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
      // 主动摘要失败：不产记录，视图保持 fold（已有记录照常生效）
      return { view: folded.view, fold: folded };
    }

    if (outcome.reason?.startsWith('denied:')) {
      emit?.({
        type: 'context.compact.error', sessionId, reason: 'proactive', error: outcome.reason,
        kind: 'denied',
      });
      return { view: folded.view, fold: folded, droppedSummary: outcome.reason };
    }

    // fresh（评审 F8-F1）= 本次产出**新的**语义摘要——只决定新记录的类型：
    // summary vs degrade。旧记录是否生效与门控无关（记录是持久事实）。
    const fresh =
      outcome.fresh === true &&
      Boolean(outcome.summary) &&
      !isMechanicalNotice(outcome.summary!);

    await this.appendRecordFromProduct({
      sessionId,
      agentId: params.agentId,
      messages,
      input: middleRaw,
      productView: Array.isArray(outcome.view) ? outcome.view : middleRaw,
      fold: folded,
      fresh,
      summarizeAttempted: outcome.summarizeAttempted === true,
      reason: 'proactive',
      summaryText: outcome.summary,
      fullTokens: currentTokens,
      estimator,
    });
    folded = this.foldView(messages, ledger);

    const reducedTokens = estimator.estimateMessages(folded.view);
    // 增长门计数随任何**完成的压缩轮**推进（含机械降级）——它是「自上次压缩新增条数」
    // 的基数；只随 fresh 推进会让无摘要会话每轮被判全量新增、复用分支永远进不去。
    this.states.set(stateKey, {
      ...state,
      lastProactiveMessageCount: messages.length,
      lastProactiveTokens: reducedTokens,
      lastProactiveFullTokens: currentTokens,
      // 只在 LLM 摘要调用真正发起过时推进冷却时间戳（成功/失败均算发起，防打爆）
      lastProactiveLlmAt: outcome.summarizeAttempted ? Date.now() : state?.lastProactiveLlmAt,
    });

    emit?.({
      type: 'context.compact.end',
      sessionId,
      reason: 'proactive',
      tokensBefore: compactTokensBefore,
      tokensAfter: rawEstimator.estimateMessages(folded.view),
      durationMs: Date.now() - proactiveStart,
      cached: false,
    });

    return {
      view: folded.view,
      fold: folded,
      droppedSummary: outcome.droppedSummary ?? 'Older turns proactively summarized',
    };
  }

  /**
   * 结构压缩：头尾保护 + 中间段摘要（不依赖 contextWindow）
   * 算法委托 capabilities/compact；本引擎把产物翻译成转换记录。
   */
  private async structuralCompact(params: {
    sessionId: string;
    agentId?: string;
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
    /** 旧压缩快照读口（迁移输入） */
    loadCompactState?: (sessionId: string) => Promise<ContextCompactSnapshot | undefined> | ContextCompactSnapshot | undefined;
  }): Promise<CompactOutcome> {
    const { sessionId, messages, summarize, estimator } = params;
    const stateKey = params.stateKey ?? compactStateKey(sessionId, params.agentId);
    const ledger = await this.loadLedger(sessionId, params.agentId, messages, params.loadCompactState);
    let folded = this.foldView(messages, ledger);
    // F6（评审挂账）：manual 计量对 = messages-only 未校准、同集合（视图前后对），
    // 与 context.compact.* 事件同口径；决策/截断仍走校准 estimator
    const raw = this.config.tokenEstimator;
    const tokensBefore = raw.estimateMessages(folded.view);

    // 同形前缀单源：优先调用方现成 llmPrefix；否则引擎内建。
    // system 字节取自会话托管 system 消息（source==='systemPrompt'）——它就是上一轮请求的逐字
    // system；重走 assembler 重建会有字节漂移（打穿缓存）。托管缺失时回落调用方 systemPrompt。
    // aging 计划与 assemble 同式——禁止手抄视图。
    const managedSystem = messages.find(
      (m) => m.role === 'system' && m.metadata?.source === 'systemPrompt',
    );
    const systemText =
      (managedSystem ? getTextContent(managedSystem.content) : '') || params.systemPrompt;
    const agingPlan = computeToolResultAgingPlan(messages, this.config.historyAging);
    const llmPrefix =
      params.llmPrefix ??
      (systemText ? this.buildLlmMessages(messages, systemText, params.tools ?? [], agingPlan) : undefined);
    const protectFirstN = this.config.protectFirstN;
    const protectLastN = this.config.protectLastN;

    if (messages.length <= protectFirstN + protectLastN) {
      return {
        ok: true,
        summary: this.deriveSummary(ledger),
        compacted: false,
        reason: 'too_short',
        tokensBefore,
        tokensAfter: tokensBefore,
        coveredMessageCount: this.derivedCoverEnd(folded),
        fresh: false,
        summarizeAttempted: false,
        view: folded.view,
      };
    }

    // 覆盖坐标：原始 messages 上 alignViewSplit → middle 语义历史 → 摘要；记录覆盖
    // [headEnd, tailStart)。禁止对 semanticHistory(全量) 切 protectHead/Tail（过滤数组
    // 下标 ≠ 原始下标，会丢消息）。
    const { headEnd, tailStart } = alignViewSplit(messages, protectFirstN, protectLastN);
    const middle = semanticHistory(messages.slice(headEnd, tailStart));

    const outcome = await this.config.compactEngine.compactMessages(
      middle,
      {
        sessionId: params.sessionId,
        ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
        protectHead: 0,
        protectTail: 0,
        targetTokens: params.compactTargetTokens,
        mode: 'structure_only',
        previousSummary: this.deriveSummary(ledger),
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
    // 不得产出 summary 型记录。**manual 失败轮不产任何记录**——失败语义（F9/F10）是
    // 「中段原文仍在视图」（宁可胖不丢），产物被整体丢弃，没有裁剪就没有记录。
    const fresh =
      outcome.fresh === true &&
      Boolean(outcome.summary) &&
      !isMechanicalNotice(outcome.summary!);

    if (!fresh) {
      return {
        ok: true,
        summary: this.deriveSummary(ledger),
        compacted: false,
        reason: outcome.reason?.startsWith('summarize_failed') || outcome.reason?.startsWith('denied:')
          ? outcome.reason
          : `summarize_failed:${outcome.reason ?? 'no_output'}`,
        tokensBefore,
        tokensAfter: tokensBefore,
        coveredMessageCount: this.derivedCoverEnd(folded),
        fresh: false,
        summarizeAttempted: outcome.summarizeAttempted,
        // 宁可胖不丢：中段原文仍在视图（未裁剪，无记录）
        view: folded.view,
      };
    }

    // fresh：产物 → summary 记录（覆盖 [headEnd, tailStart)），fold 出视图
    const fullTokens = estimator.estimateMessages(
      applyAgingToMessages(messages, agingPlan, this.config.historyAging),
    );
    const record = await this.appendRecordFromProduct({
      sessionId,
      agentId: params.agentId,
      messages,
      input: messages.slice(headEnd, tailStart),
      productView: Array.isArray(outcome.view) ? outcome.view : [],
      fold: folded,
      fresh: true,
      summarizeAttempted: outcome.summarizeAttempted === true,
      reason: 'manual',
      summaryText: outcome.summary,
      fullTokens,
      estimator,
    });
    folded = this.foldView(messages, ledger);
    const tokensAfter = raw.estimateMessages(folded.view);

    this.states.set(stateKey, {
      ...this.states.get(stateKey),
      lastProactiveMessageCount: messages.length,
      lastProactiveTokens: estimator.estimateMessages(folded.view),
      // 增长门全量基数随任何完成的压缩轮推进（manual 同口径；重启恢复对称）
      lastProactiveFullTokens: fullTokens,
      lastProactiveLlmAt: outcome.summarizeAttempted ? Date.now() : this.states.get(stateKey)?.lastProactiveLlmAt,
    });

    return {
      ok: true,
      summary: outcome.summary,
      compacted: record !== undefined,
      tokensBefore,
      tokensAfter,
      coveredMessageCount: record ? tailStart : this.derivedCoverEnd(folded),
      fresh: true,
      summarizeAttempted: outcome.summarizeAttempted,
      coverage: outcome.coverage,
      // 度量=装配严格同形：返还 fold 视图（与 tokensAfter 同源）
      view: folded.view,
    };
  }

  /**
   * 结构压缩入口（手动）— 可无 contextWindow
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
    /** 旧压缩快照读口（迁移输入；缺省不迁移） */
    loadCompactState?: (sessionId: string) => Promise<ContextCompactSnapshot | undefined> | ContextCompactSnapshot | undefined;
  }): Promise<CompactOutcome> {
    const stateKey = compactStateKey(input.sessionId, input.agentId);
    // R1（评审 #5）：manual 压缩同样是决策路径（目标裁剪 / tokensBefore|After 读数），
    // 须与 assemble 同走校准口径；modelKey 复用会话最近一次 assemble 的分键。
    const estimator = this.sizeLedger.calibratedEstimator(
      this.states.get(stateKey)?.modelKey ?? 'unknown',
      this.config.tokenEstimator,
    );
    const result = await this.structuralCompact({
      sessionId: input.sessionId,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
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
      loadCompactState: input.loadCompactState,
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
   * 使用 LLM 返回的真实 usage 校准 token 估算：把（实测 prompt, 请求口径估算）样本
   * 送入 ContextSizeLedger（P1-a，ratio 按 model 分键）。
   */
  async afterStep(params: AfterStepParams): Promise<void> {
    const { sessionId, agentId, usage } = params;

    if (!usage) return;

    const stateKey = compactStateKey(sessionId, agentId);
    const state = this.states.get(stateKey) ?? {};

    // 真实 prompt tokens（provider 报告优先，分项和兜底——与展示口径同源）
    const promptActual =
      usage.inputReportedTokens ??
      usage.inputUncachedTokens + usage.inputCachedTokens + usage.inputCacheWriteTokens;

    // P1-a：校准样本入台账——分母 = state.lastEstimatedTokens（「system+tools+视图」请求
    // 口径的未校准估算，与 modelKey 同槽配对），分子 = provider 实测。ratio 按 model 分键
    // 跨 session 共享。
    if (state.lastEstimatedTokens && state.lastEstimatedTokens > 0 && promptActual > 0) {
      this.sizeLedger.observe(state.modelKey ?? 'unknown', promptActual, state.lastEstimatedTokens, {
        sessionId,
      });
    }
    // 降级 B 锚（arch §10.16，评审 F3）：{actual, raw} 同请求同源冻结成对写入——
    // 两字段分开读写会让失败步后的 actual 与下一轮 raw 错位配对（除数漂移）
    if (promptActual > 0 && state.lastEstimatedTokens && state.lastEstimatedTokens > 0) {
      this.states.set(stateKey, {
        ...this.states.get(stateKey),
        lastUsageAnchor: {
          actual: promptActual,
          raw: state.lastEstimatedTokens,
          modelKey: state.modelKey ?? 'unknown',
        },
      });
    }
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
      // 反向围栏（B0）：非托管 system 一律降级为 engineHint 载体（user 形态，内容原样），
      // 不丢弃（不静默失忆）也绝不进 provider system 字段——system 槽位只归托管
      // systemPrompt 一条；外来 system 进字段会让前缀从第 0 字节失效
      // （context-size-accounting.md §1），且 provider 适配层按「system ≤ 1」断言。
      const llmMsg =
        msg.role === 'system'
          ? { ...msg, role: 'user' as const, metadata: { ...msg.metadata, source: 'engineHint' } }
          : msg;
      result.push(...this.convertMessage(llmMsg, aging));
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
