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
   * 单次摘要 LLM 调用预算（ms）。0 = 不设预算（只受 provider 超时约束）。
   * 默认 300_000：摘要请求体量与视图同阶（P2 后约 100–200KB），正常远低于此值；
   * 留足慢 provider / 大请求的余量，同时给「provider 挂死」一个确定上界——超时即中止，
   * 按 onSummarizeFail 降级（2026-11-07 事故）。中断不续做：下一轮重新发起即可。
   */
  summarizeTimeoutMs?: number;
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
  /**
   * turn 内（工具活动进行中）主动压缩的保护尾条数（2026-11-07 方案 E 修订）。
   * turn 内进行中的工作记录（最近的工具步骤/证据/推理链）不进压缩选段，由活跃窗口保护；
   * 窗口外的执行痕迹可正常语义压缩（长任务 turn 内上下文持续增长时目标线才真正生效）。
   * turn 边界仍用 protectLastN。默认 50；取 max(protectLastN, midTurnProtectLastN)。
   */
  midTurnProtectLastN?: number;
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
 * 决策状态：校准配对（pendingUsagePair/lastModelKey/lastUsageAnchor）与增长门/
 * 冷却基数（记录生成时推进，重启从账本 meta 恢复）。
 */
interface CompactState {
  /** 请求级冻结配对槽（2026-11-07）：assemble 写入**本请求**的未校准估算与 modelKey，
   *  afterStep 消费一次（读后即清）。缺对丢样——不拿旧估算配新实测（跨请求错位配对
   *  会产出毒 ratio 样本，arch §10.14）。恒为「system+tools+视图」请求口径（P1-a 校准
   *  分母）；只允许请求口径写点写入（assemble 的三个出口），compact 路径的 messages-only
   *  值不得写入，否则 calibrationRatio 被口径错位结构性抬高。 */
  pendingUsagePair?: { rawEstimatedTokens: number; modelKey: string; seq: number; orphaned?: boolean };
  /** 配对槽序号（callId 同源配对，2026-11-08）：每次冻结递增，审计/覆盖判定用 */
  pairSeq?: number;
  /** 会话最近一次 assemble 的分键（manual 压缩校准用，常驻不消费；与配对槽同源写入） */
  lastModelKey?: string;
  /** 降级 B 锚（arch §10.16，评审 F3 原子对）：{实测 prompt, 同请求未校准估算, modelKey}
   *  冻结写入——只从 observe 裁决 accepted 的干净对冻结（clamped/rejected/rebased 样本
   *  成锚即毒锚，外推可把决策读数放大数倍）；压缩完成即清（请求形状已变，旧锚失效）。 */
  lastUsageAnchor?: { actual: number; raw: number; modelKey: string };
  /** 上次压缩轮的全量条数（再压缩增长门 newSinceLast 基数；随任何完成的压缩轮推进） */
  lastProactiveMessageCount?: number;
  /** 上次压缩轮后的**请求口径**读数（fold 视图 + 老化）——展示/恢复用，每轮装配都会刷新。 */
  lastProactiveTokens?: number;
  /** 增长门基数：**上次压缩完成时**的请求口径读数（fold 视图 + 老化），只在压缩完成时推进。
   *  与 lastProactiveTokens 分开是必须的：后者每轮装配都刷新，若拿它当基数，
   *  基数永远追上当前读数 → grownEnough 恒 false → 压缩永久饿死。 */
  lastCompactGateTokens?: number;
  /** 上次真正发起 LLM 摘要调用的时间戳（冷却） */
  lastProactiveLlmAt?: number;
  /**
   * overflow 每 turn 至多发起一次 LLM 摘要（2026-11-07 止血）：记发起时的
   * lastGenuineUserIndex 作 turn key（历史 append-only，同 turn 内稳定）。
   * 连环触发的事故形态：冷却从完成起算+无增长门，一轮内反复削尖（200k→200k）。
   * 完整触发纪律（无进展熔断/冷却从发起计时/目标统一）待 overflow 重构讨论后定。
   */
  overflowLlmTurnIndex?: number;
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
      summarizeTimeoutMs: config?.summarizeTimeoutMs ?? 300_000,
      historyAging: resolveToolResultAgingOptions(config?.historyAging),
      targetTokens: config?.targetTokens ?? 200_000,
      // <1 或非法值回落缺省——0 会把目标线压成 0（压缩风暴），不是「禁用」语义
      compactFallbackRatio:
        config?.compactFallbackRatio != null && config.compactFallbackRatio >= 1
          ? config.compactFallbackRatio
          : 3,
      // 非法/0 值回落缺省 50（0 会退化成 protectLastN，不是「关闭」语义——评审 m3）；
      // 有效值再与 protectLastN 取 max（活跃窗口不得窄于常态保护尾）
      midTurnProtectLastN:
        config?.midTurnProtectLastN != null && config.midTurnProtectLastN >= 1
          ? config.midTurnProtectLastN
          : 50,
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
              signal: params.signal,
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
      this.freezeUsagePair(stateKey, rawEstimatedTokens, modelKey);
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
      signal: params.signal,
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

      this.freezeUsagePair(stateKey, rawEstimatedTokens, modelKey);

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
    // 每 turn 至多一次 overflow LLM 摘要（2026-11-07 止血）：冷却从完成起算 + 无增长门时
    // 一轮内会反复触发反复削尖（连环 200k→200k 事故）。turn key = 末条真实 user 下标——
    // **下标身份不跨改写稳定**（可靠性 truncate_context/租约切片会改写数组，key 变化
    // 视为新 turn，属已知宽松面，完整触发纪律待 overflow 重构）。key < 0（无真实 user）
    // 不落名额、仅受冷却约束，防 -1 永久锁死。名额只在**产出 fresh 摘要**时消耗
    // （评审 M5）：失败/超时不烧名额（冷却后可重试），denied 推冷却但不烧名额。
    const overflowTurnKey = lastGenuineUserIndex(messages);
    const overflowLlmDoneThisTurn =
      overflowTurnKey >= 0 &&
      state?.overflowLlmTurnIndex !== undefined &&
      state.overflowLlmTurnIndex === overflowTurnKey;
    const skipLlmCompaction =
      compactionCannotHelp ||
      overflowInCooldown ||
      overflowNewSinceLast < overflowMinNew ||
      overflowLlmDoneThisTurn;
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
      // P3：溢出路径同样受 run abort 与摘要预算约束（此前三条路径都没有 signal）
      const overflowBudget = this.createSummarizeSignal(params.signal);
      // 上游已中止：跳过本轮全部压缩动作（含机械降级），不写任何记录。
      // 中止代表本轮请求作废，此时写记录只会用残缺产物污染历史。
      if (params.signal?.aborted) {
        // M-1：中止收尾必须发终态事件，否则 store 的 compact.active 永久悬挂（UI 卡「进行中」）
        emit?.({
          type: 'context.compact.end',
          sessionId,
          reason: 'overflow',
          durationMs: Date.now() - overflowStart,
          cancelled: true,
        });
        const abortedLlmMessages = this.buildLlmMessages(view, systemPrompt, tools, agingPlan);
        return {
          messages: abortedLlmMessages,
          estimatedTokens: rawEstimator.estimateMessages(view) + rawEstimator.estimateTools(tools),
          readingSource: 'raw',
          systemPrompt,
          droppedSummary: proactiveDroppedSummary,
          summary: this.deriveSummary(ledger),
        };
      }
      switch (skipLlmCompaction ? 'cannot_help' : routing.route) {
        // B′（2026-11-03 拍板）：溢出统一走真摘要（打码降为机械降级阶梯第一级）
        case 'compact': {
          emit?.({
            type: 'context.compact.progress',
            sessionId,
            reason: 'overflow',
            phase: 'summarize',
            requestChars: JSON.stringify(overflowLlmPrefix).length,
            requestMessages: overflowLlmPrefix.length,
            timeoutMs: this.config.summarizeTimeoutMs || undefined,
          });
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
            signal: overflowBudget.signal,
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
            // denied 也计入「已尝试」推冷却（评审 M5）：否则策略钩子每轮重复触发
            // （HITL 场景反复弹确认）。名额不在这里消耗——只认 fresh 摘要。
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

    // M-2（2026-11-07 评审）：中止轮零写入——摘要可能在飞行中被 abort，错误被 compactCore
    // catch 成降级产物**不抛出**，若不在此拦住，残缺产物（degrade/半截 summary）会落进
    // 历史并在下一次 fold 生效（违反「中止轮不写记录」承诺）。与 proactive 的调用后检查同形。
    if (params.signal?.aborted) {
      emit?.({
        type: 'context.compact.end',
        sessionId,
        reason: 'overflow',
        durationMs: Date.now() - overflowStart,
        cancelled: true,
      });
      return {
        messages: this.buildLlmMessages(view, systemPrompt, tools, agingPlan),
        estimatedTokens: rawEstimator.estimateMessages(view) + rawEstimator.estimateTools(tools),
        readingSource: 'raw',
        systemPrompt,
        droppedSummary: proactiveDroppedSummary,
        summary: this.deriveSummary(ledger),
      };
    }

    // 6. 产物 → 持久转换记录（记录先落盘，视图后发）
    const overflowRecord = await this.appendRecordFromProduct({
      sessionId,
      agentId,
      messages,
      input: selection.overflow,
      productView,
      fold: folded,
      // overflow 与主动路径同口径度量（viewTokens 供展示/恢复；overflow 不推进增长门）
      agingPlan,
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
    // 随之推进会饿死真摘要的增长门）。冷却推「已尝试」；本 turn 名额只认 fresh 摘要
    // （失败/超时/ denied 不烧名额，冷却后可重试——评审 M5）；key<0 不落名额（M3）。
    this.states.set(stateKey, {
      ...state,
      lastProactiveLlmAt: overflowSummarizeAttempted
        ? Date.now()
        : state?.lastProactiveLlmAt,
      overflowLlmTurnIndex:
        overflowFresh && overflowTurnKey >= 0
          ? overflowTurnKey
          : state?.overflowLlmTurnIndex,
      // 锚卫生（评审 m4）：只有真产出转换记录（请求形状已变）才清锚；
      // 什么都没变的轮清锚只会把下一轮决策打回裸估算
      lastUsageAnchor: overflowRecord === undefined ? state?.lastUsageAnchor : undefined,
    });

    emit?.(
      overflowRecord === undefined
        ? rawEstimator.estimateMessages(view) > effectiveMessagesLimit
          ? // 无记录且视图仍超预算 = 压缩救不了（cannot_help）：**必须可见**（评审 M4），
            // 不得伪装成良性复用——「上下文已超窗」是需要暴露的异常
            {
              type: 'context.compact.error',
              sessionId,
              reason: 'overflow',
              error: 'cannot_help: view remains over budget with nothing compressible',
              durationMs: Date.now() - overflowStart,
            }
          : // 无记录且视图可装 = 真良性空转（auto 短路）：复用重建同形，cached 不入会话流；
            // 计量对取同集合真实值（与 start 口径一致，不发 0/0 假计量）
            {
              type: 'context.compact.end',
              sessionId,
              reason: 'overflow',
              tokensBefore: compactTokensBefore,
              tokensAfter: compactTokensBefore,
              durationMs: Date.now() - overflowStart,
              cached: true,
            }
        : {
            type: 'context.compact.end',
            sessionId,
            reason: 'overflow',
            tokensBefore: compactTokensBefore,
            tokensAfter: rawEstimator.estimateMessages(view),
            durationMs: Date.now() - overflowStart,
            cached: false,
          },
    );

    // 8. 构建 LLM 消息（校准基 = 老化后 LLM 视图估算——尺子必须量实际请求）
    const llmMessages = this.buildLlmMessages(view, systemPrompt, tools, agingPlan);
    const rawEstimatedTokens = estimateLLMMessages(llmMessages) + rawEstimator.estimateTools(tools);
    const decision = this.sizeLedger.decisionTokensWithSource(
      modelKey,
      rawEstimatedTokens,
      this.states.get(stateKey)?.lastUsageAnchor,
    );
    this.freezeUsagePair(stateKey, rawEstimatedTokens, modelKey);

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

  /**
   * 摘要调用预算（P3）：外部 abort 与单次摘要超时合并成一个 signal。
   *
   * 为什么必须合并：run 中止只到 convertToLlm 边界，摘要调用在 `provider.chat` 内部
   * 等待 HTTP；没有 signal 时 abort 只能等 provider 自己超时（实测 900s，UI 全程假死）。
   *
   * @param external - 上游（run）abort 信号
   * @returns 合并信号与「是否超时」判定（超时归失败降级，外部中止归取消不写记录）
   */
  private createSummarizeSignal(external?: AbortSignal): {
    signal: AbortSignal | undefined;
    timedOut: () => boolean;
  } {
    const timeoutMs = this.config.summarizeTimeoutMs;
    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    if (!external) {
      return {
        signal: timeoutSignal,
        timedOut: () => timeoutSignal?.aborted === true,
      };
    }
    if (!timeoutSignal) return { signal: external, timedOut: () => false };
    return {
      signal: AbortSignal.any([external, timeoutSignal]),
      timedOut: () => timeoutSignal.aborted,
    };
  }

  /**
   * 请求口径读数：**fold 视图 + 老化** = 实际发给 LLM 的 messages 部分。
   *
   * 压缩决策（触发线、增长门、记录 meta）只许用这个口径：量原文会让「已压缩但视图很小」
   * 的会话被反复判超线（2026-11-07 事故：视图 118k、原文 621k → 每次增长 25% 必然重压）。
   *
   * @param folded - 当前 fold 结果
   * @param agingPlan - 老化计划（基于完整历史，按消息身份匹配）
   * @param estimator - 校准后的估算器
   * @returns messages 口径 token 估算
   */
  private measureRequestViewTokens(
    folded: FoldResult,
    agingPlan: ToolResultAgingPlan,
    estimator: TokenEstimator,
  ): number {
    return estimator.estimateMessages(
      applyAgingToMessages(folded.view, agingPlan, this.config.historyAging),
    );
  }

  /**
   * 摘要请求的回声比对源（P2）：前缀去掉既有压缩占位。
   *
   * 前缀已是 fold 视图时，占位正文就是「上一份交接书」——模型续写/复用它是正常迭代，
   * 不是复读原文；若把占位计入比对源，只要新增内容不多就会误判 verbatim_echo 并降级。
   *
   * @param view - 摘要前缀所用的消息（fold 视图）
   * @param systemPrompt - 同形 system
   * @param agingPlan - 老化计划（与真实请求同式）
   * @returns 换行拼接的文本投影
   */
  private buildEchoSource(
    view: Message[],
    systemPrompt: string,
    agingPlan: ToolResultAgingPlan,
  ): string {
    const conversation = view.filter(
      (m) => m.metadata?.source !== 'contextSummary' && m.metadata?.source !== 'contextLedger',
    );
    return this.buildLlmMessages(conversation, systemPrompt, [], agingPlan)
      .map((m) => String(m.content ?? ''))
      .join('\n');
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
    // 口径版本守卫：旧记录的 viewTokens 是另一套口径（未老化、非请求形状），拿它当增长门
    // 基数会与请求口径互比 → 永远判「没长够」而永久压制压缩。无版本标记 = 无基数，
    // 允许下一次压缩自愈（代价至多多压一次）。
    const gateTokens =
      gateBase?.meta.viewTokensSource === 'request' ? gateBase.meta.viewTokens : undefined;
    this.states.set(stateKey, {
      ...(gateBase
        ? {
            lastProactiveMessageCount: gateBase.meta.messageCount,
            ...(gateTokens !== undefined
              ? { lastProactiveTokens: gateTokens, lastCompactGateTokens: gateTokens }
              : {}),
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
    /** 老化计划：meta.viewTokens 必须与真实请求同口径（fold 视图 + 老化） */
    agingPlan: ToolResultAgingPlan;
    fresh: boolean;
    summarizeAttempted: boolean;
    reason: 'proactive' | 'overflow' | 'manual';
    /** fresh 语义摘要正文（有则 summary 型） */
    summaryText?: string;
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

    // C-1（2026-11-07 评审）：degrade 不得吞既有记录区间——不仅跳过占位项（见下），
    // **raw 项同样要查**：proactive 的 input 是原 messages 中段（已覆盖区间以 raw 形式
    // 出现），此前只护占位项，degrade 的机械 span 会整段覆盖旧 summary 记录的区间
    // （fold 后写覆盖）→ 交接书从视图静默消失。fold 模块契约「degrade 永不覆盖
    // 占位 span」对 raw 项同样成立。
    const coveredByRecord: Array<[number, number]> = [];
    if (!freshOk) {
      for (const run of params.fold.applied) coveredByRecord.push(...run.spans);
    }
    const isCovered = (idx: number): boolean =>
      coveredByRecord.some(([a, b]) => idx >= a && idx <= b);

    const spans: Array<[number, number]> = [];
    for (const item of params.input) {
      if (kept.has(item)) continue;
      const idx = rawIndex.get(item);
      if (idx !== undefined) {
        // degrade：既有记录覆盖的 raw 不接管（宁可少覆盖，不得吞摘要）
        if (!freshOk && isCovered(idx)) continue;
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
      },
    };

    // 记录 meta 的视图估算：以「记录生效后的 fold」度量（度量=装配），
    // 且与真实请求同口径（老化 + fold）——增长门基数只认这个读数
    const virtual: TransformLedger = {
      records: [
        ...this.ledgers.get(compactStateKey(params.sessionId, params.agentId))!.records,
        { ...record, seq: -1, blobRef: undefined, revoked: false },
      ],
    };
    const virtualFold = foldTransformView(params.messages, virtual, {});
    record.meta.viewTokens = this.measureRequestViewTokens(
      virtualFold,
      params.agingPlan,
      params.estimator,
    );
    record.meta.viewTokensSource = 'request';

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
    /** run 中止信号（P3）：摘要调用随之取消（不写记录、不推进状态） */
    signal?: AbortSignal;
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
    // 方案 E 修订（2026-11-07）：turn 内不再禁止 LLM 摘要，改为活跃窗口保护——
    // tail 扩大到 midTurnProtectLastN 条（进行中的工具步骤/证据/推理链不进选段），
    // 窗口外的执行痕迹正常语义压缩；长任务 turn 内目标线由此真正生效。
    const midTurn = isMidTurn(messages);
    const tailCount = midTurn
      ? Math.max(protectLastN, this.config.midTurnProtectLastN)
      : protectLastN;
    const { headEnd, tailStart } = alignViewSplit(messages, protectFirstN, tailCount);
    // 锚点硬保护（评审 M2）：当前 turn 的真实 user 消息（含 turn_context/指令约束）
    // 永不进选段——turn 内压缩不得吞掉任务的原始指令，模型续跑只能靠摘要转述风险太大。
    // 老 turn 的锚点已由历史 summary 记录覆盖语义，这里只保最后一条（当前 turn）。
    const anchorIdx = lastGenuineUserIndex(messages);
    const middleRaw = messages
      .slice(headEnd, tailStart)
      .filter((_m, i) => headEnd + i !== anchorIdx);
    const middle = semanticHistory(middleRaw); // 仅供 summarize 素材，禁止回装进视图

    // 请求口径（F1-B3 + 2026-11-07 修正）：读数 = **fold 视图 + 老化** = 实际发给 LLM 的内容。
    // 旧实现量「老化后的全量历史」：压缩把视图压小，却压不动读数，于是已压缩会话
    // （实测视图 118k / 原文 621k）只要历史再涨 25% 就必然再压一次 —— 越压越发全量。
    // 压缩输入仍用原 messages（摘要质量需要原文）。
    const agedView = applyAgingToMessages(folded.view, agingPlan, this.config.historyAging);
    const currentTokens = estimator.estimateMessages(agedView);

    // 头/尾保护窗在**视图坐标**上的条数（fold 只覆盖中段，首尾原样保留）
    const viewCount = folded.view.length;
    const headCountInView = Math.min(headEnd, viewCount);
    const tailCountInView = Math.min(
      Math.max(0, messages.length - tailStart),
      viewCount - headCountInView,
    );
    const agingHead = agedView.slice(0, headCountInView);
    const agingTail = tailCountInView > 0 ? agedView.slice(viewCount - tailCountInView) : [];

    const headTailTokens =
      estimator.estimateMessages(agingHead) + estimator.estimateMessages(agingTail);

    // 两条触发线（都保留；刻意不用 legacy 命名，防被当成死代码清掉）：
    const targetLine = Math.ceil(this.config.targetTokens * this.config.compactFallbackRatio);
    const windowRatioLine =
      messagesBudget > 0 ? Math.floor(messagesBudget * ratio) : Number.POSITIVE_INFINITY;

    // ratio=0：禁止发起新的路径 A 压缩（不只禁 LLM）。已有记录照常生效（fold）。
    if (ratio <= 0) {
      if (hasCompactView) {
        this.states.set(stateKey, {
          ...state,
          lastProactiveTokens: this.measureRequestViewTokens(folded, agingPlan, estimator),
        });
      }
      return { view: folded.view, fold: folded };
    }

    // 触发线：目标线与窗口比例线取 min。单位：比较双方都是**校准后** token 读数。
    // 数值：threshold = min(targetLine, windowRatioLine)（arch/context-size-accounting.md §5.2）。
    const threshold =
      this.config.targetTokens > 0 ? Math.min(targetLine, windowRatioLine) : windowRatioLine;

    // 失败降级的机械账本目标（structure_only 下该值只作用于 summarize 失败后的
    // mechanicalDegrade，不影响摘要大小——摘要走 summaryBudget clamp）。
    // 地板 2000（评审 m2）：tail 活跃窗口扩大后 headTailTokens 变大，200 地板会把
    // 失败降级压成极瘦账本（比降级前狠得多），宁可账本胖一点也别丢太多。
    const targetMiddleTokens = Math.max(
      2000,
      Math.floor(threshold * 0.55) - headTailTokens,
    );

    // 新 LLM 压缩闸门（方案 E 修订，2026-11-07）：只看 summarize 可用性。
    // 旧版 turn 内禁止新 LLM 摘要（保护活动工作记录）——但 agent 式长 turn 让该禁令
    // 全程生效，目标线失效、长任务只能落 overflow 削尖。保护改由活跃窗口承担
    // （切割处 turn 内 tail 扩到 midTurnProtectLastN 条），窗口外执行痕迹正常压缩。
    const allowNewLlmCompact = !!summarize;

    // 未超线：fold 视图（记录天然粘滞）
    if (currentTokens <= threshold) {
      if (hasCompactView) {
        this.states.set(stateKey, {
          ...state,
          lastProactiveTokens: this.measureRequestViewTokens(folded, agingPlan, estimator),
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
    // 增长门（target 模式；防「偶发兜底」变「周期压缩」）：只有**同一请求口径**读数较上次
    // **压缩完成时**实质增长（≥ 25% 阈值）才允许再打 LLM。基数只认 lastCompactGateTokens——
    // 不能用 lastProactiveTokens（每轮装配都刷新）当基数，否则基数永远追上当前读数、
    // grownEnough 恒 false，压缩永久饿死。
    const lastViewTokens = state?.lastCompactGateTokens;
    const grownEnough =
      this.config.targetTokens <= 0 ||
      lastViewTokens === undefined ||
      currentTokens >= lastViewTokens + Math.max(1, Math.floor(threshold * 0.25));
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
        lastProactiveTokens: this.measureRequestViewTokens(folded, agingPlan, estimator),
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

    // 无 summarize：超线也不打摘要 LLM（fold 机械分级照常）
    if (!allowNewLlmCompact) {
      return { view: folded.view, fold: folded };
    }

    // 需要新一轮压缩：压缩 head/tail 之间的中间段（语义历史，不含 grounding）。
    if (middle.length === 0) {
      return { view: folded.view, fold: folded };
    }

    // 待并入摘要的新消息 = 「上一份摘要覆盖终点之后、保护尾之前」。
    // 视图超线但这里为 0（中段全被既有摘要覆盖）：重压只会原样复述上一份交接书——
    // P2 让重压请求变便宜后，若不拦住就会退化成每轮一次「摘要风暴」。零 LLM 复用。
    const coveredEnd = Math.max(this.derivedCoverEnd(folded) ?? headEnd, headEnd);
    const coveredCount = coveredEnd - headEnd;
    const newFoldCount = Math.max(0, tailStart - coveredEnd);
    if (coveredCount > 0 && newFoldCount === 0) {
      if (hasCompactView) {
        this.states.set(stateKey, {
          ...state,
          lastProactiveTokens: this.measureRequestViewTokens(folded, agingPlan, estimator),
        });
      }
      return { view: folded.view, fold: folded };
    }

    const proactiveStart = Date.now();
    // P3：摘要调用的预算信号（run abort ∪ 单次摘要超时）；取消/超时都从这里出来
    const summarizeBudget = this.createSummarizeSignal(params.signal);
    if (params.signal?.aborted) {
      // 上游已中止：不发起压缩、不写记录（本轮已经作废，留下记录只会污染历史）
      return { view: folded.view, fold: folded };
    }
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
      // P2（2026-11-07）：前缀 = **折叠视图**，与主会话请求逐字节同形 → 吃前缀缓存。
      // 旧实现用原 messages（全部历史）：折叠生效后两者形状不同 → 缓存 0 命中，
      // 且每次重压都把已压缩过的中段原封不动再发一遍（实测 2.13MB 请求、provider 不返回）。
      const llmPrefix = this.buildLlmMessages(folded.view, systemPrompt, tools, agingPlan);
      // 回声源排除既有摘要占位：模型续写上一份交接书不是「复读原文」
      const echoSource = this.buildEchoSource(folded.view, systemPrompt, agingPlan);
      // P3 可观测：摘要请求即将发出——如实上报请求体量与预算，UI 不再只显示「进行中」
      emit?.({
        type: 'context.compact.progress',
        sessionId,
        reason: 'proactive',
        phase: 'summarize',
        requestChars: JSON.stringify(llmPrefix).length,
        requestMessages: llmPrefix.length,
        timeoutMs: this.config.summarizeTimeoutMs || undefined,
      });
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
          // 视图口径：前缀已含上一份摘要，本次只需并入它之后的新消息；
          // coveredCount>0 时指令改述为「继续合并」，与模型实际所见一致
          replacedCount: newFoldCount,
          total: messages.length,
          preservedTail: messages.length - tailStart,
          ...(coveredCount > 0 ? { coveredCount } : {}),
        },
        contextWindow: params.contextWindow,
        maxOutputTokens: params.maxOutputTokens,
        onSummarizeFail: 'truncate',
        llmPrefix,
        echoSource,
        signal: summarizeBudget.signal,
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

    // P3：上游中止（用户 abort）——本轮已作废，不写记录也不推进增长门基数，
    // 否则会用一次残缺压缩污染会话历史。M-1：收尾必须发终态事件（cancelled），
    // 否则 store 的 compact.active 永久悬挂（UI 卡「摘要进行中」）。
    if (params.signal?.aborted) {
      emit?.({
        type: 'context.compact.end',
        sessionId,
        reason: 'proactive',
        durationMs: Date.now() - proactiveStart,
        cancelled: true,
      });
      return { view: folded.view, fold: folded };
    }
    // P3：摘要超时 → 如实上报（kind=failed），按既有 onSummarizeFail 语义降级为机械记录
    if (summarizeBudget.timedOut() && outcome.reason?.startsWith('summarize_failed')) {
      emit?.({
        type: 'context.compact.error',
        sessionId,
        reason: 'proactive',
        error: `summarize_timeout:${this.config.summarizeTimeoutMs}ms (${outcome.reason})`,
        kind: 'failed',
        durationMs: Date.now() - proactiveStart,
      });
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
      agingPlan,
      fresh,
      summarizeAttempted: outcome.summarizeAttempted === true,
      reason: 'proactive',
      summaryText: outcome.summary,
      estimator,
    });
    folded = this.foldView(messages, ledger);

    const reducedTokens = this.measureRequestViewTokens(folded, agingPlan, estimator);
    // 增长门计数随任何**完成的压缩轮**推进（含机械降级）——它是「自上次压缩新增条数」
    // 的基数；只随 fresh 推进会让无摘要会话每轮被判全量新增、复用分支永远进不去。
    this.states.set(stateKey, {
      ...state,
      lastProactiveMessageCount: messages.length,
      lastProactiveTokens: reducedTokens,
      // 增长门基数只在**压缩完成**时推进（视图口径，与 currentTokens 同源）
      lastCompactGateTokens: reducedTokens,
      // 锚卫生：压缩改变请求形状，旧锚的 (actual,raw) 对不再对应任何未来请求 → 即刻失效
      lastUsageAnchor: undefined,
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
    /** 中止信号（P3）：手动压缩通常无 run 级 signal，仅摘要预算生效（传了则一并取消） */
    signal?: AbortSignal;
  }): Promise<CompactOutcome> {
    const { sessionId, messages, summarize, estimator } = params;
    const stateKey = params.stateKey ?? compactStateKey(sessionId, params.agentId);
    const ledger = await this.loadLedger(sessionId, params.agentId, messages, params.loadCompactState);
    let folded = this.foldView(messages, ledger);
    const raw = this.config.tokenEstimator;

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
    // 计量口径（2026-11-08 三数字核对拍板）：before/after 用「报告尺」= fold 视图 + 老化 +
    // system + tools 的未校准估算（rawRequestViewTokens，与 assemble 的 rawEstimatedTokens
    // /配对槽分母同式）。注意与「决策尺」分工：proactive/overflow 触发与增长门基数走
    // measureRequestViewTokens（校准后 messages-only）——report vs decision 两把尺各有其职，
    // 勿互换（互换会搅乱增长门基数，见 arch/context-size-accounting.md §10.19）。
    // 旧口径「未老化 fold 视图 messages-only」量的是存储形态不是请求（缺 aging 降级、
    // 缺 system/tools），toast 数字与顶栏永远对不上。
    const rawRequestViewTokens = (fold: { view: Message[] }): number =>
      estimateLLMMessages(
        this.buildLlmMessages(fold.view, systemText ?? '', params.tools ?? [], agingPlan),
      ) + raw.estimateTools(params.tools ?? []);
    const tokensBefore = rawRequestViewTokens(folded);
    // P2：前缀 = 折叠视图（与主会话请求同形）；调用方显式给的前缀仍优先
    const llmPrefix =
      params.llmPrefix ??
      (systemText
        ? this.buildLlmMessages(folded.view, systemText, params.tools ?? [], agingPlan)
        : undefined);
    // 回声源只对引擎自建的前缀生效（调用方前缀的形状我们无从得知，回落到前缀投影）
    const echoSource =
      !params.llmPrefix && llmPrefix
        ? this.buildEchoSource(folded.view, systemText ?? '', agingPlan)
        : undefined;
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
    // P2 视图口径：前缀已含上一份摘要，本次只需并入它之后、保护尾之前的新消息
    const coveredEnd = Math.max(this.derivedCoverEnd(folded) ?? headEnd, headEnd);
    const coveredCount = coveredEnd - headEnd;
    const newFoldCount = Math.max(0, tailStart - coveredEnd);

    // P3：手动压缩同样受摘要预算约束（无 run signal 时只有超时；超时 → 失败不产记录）
    const manualBudget = this.createSummarizeSignal(params.signal);
    if (llmPrefix) {
      params.emit?.({
        type: 'context.compact.progress',
        sessionId: params.sessionId,
        phase: 'summarize',
        requestChars: JSON.stringify(llmPrefix).length,
        requestMessages: llmPrefix.length,
        timeoutMs: this.config.summarizeTimeoutMs || undefined,
      });
    }
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
        // 折叠区间（评审 F7 / P2）：摘要并入「上一份摘要之后、保护尾之前」的新消息
        foldRange: {
          replacedCount: newFoldCount,
          total: messages.length,
          preservedTail: messages.length - tailStart,
          ...(coveredCount > 0 ? { coveredCount } : {}),
        },
        contextWindow: params.contextWindow,
        maxOutputTokens: params.maxOutputTokens,
        onSummarizeFail: 'truncate',
        llmPrefix,
        echoSource,
        signal: manualBudget.signal,
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
    const record = await this.appendRecordFromProduct({
      sessionId,
      agentId: params.agentId,
      messages,
      input: messages.slice(headEnd, tailStart),
      productView: Array.isArray(outcome.view) ? outcome.view : [],
      fold: folded,
      agingPlan,
      fresh: true,
      summarizeAttempted: outcome.summarizeAttempted === true,
      reason: 'manual',
      summaryText: outcome.summary,
      estimator,
    });
    folded = this.foldView(messages, ledger);
    // after 同口径（报告尺）；摘要段用 provider 实测输出 tokens 真值替换估算（2026-11-08）。
    // 只在记录真正落账（record 存在）时替换——record 缺失 = 产物没进视图，摘要不在请求里；
    // outputTokens 须 >0（0 是「未回传」的常见形态，防把 after 减到近 0）。
    let tokensAfter = rawRequestViewTokens(folded);
    if (record && outcome.summary && (outcome.summaryOutputTokens ?? 0) > 0) {
      tokensAfter =
        tokensAfter - raw.estimateText(outcome.summary) + outcome.summaryOutputTokens!;
    }

    const afterViewTokens = this.measureRequestViewTokens(folded, agingPlan, estimator);
    this.states.set(stateKey, {
      ...this.states.get(stateKey),
      lastProactiveMessageCount: messages.length,
      // 展示读数与增长门基数同口径（manual 压缩完成 = 基数推进到压缩后视图）
      lastProactiveTokens: afterViewTokens,
      lastCompactGateTokens: afterViewTokens,
      // 锚卫生：压缩改变请求形状，旧锚即刻失效
      lastUsageAnchor: undefined,
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
      summaryOutputTokens: outcome.summaryOutputTokens,
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
      this.states.get(stateKey)?.lastModelKey ?? 'unknown',
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
   * 冻结请求级配对槽（callId 同源配对的唯一写入口，2026-11-08）。
   *
   * 每次冻结携带单调 seq（pairSeq）作请求身份；覆盖未消费的旧槽即作废并告警——
   * 「上一请求 usage 未到就再次装配」正是错位对（0.085/0.258 家族）的嫌疑通道，
   * 静默覆盖会让旧估算去配陌生 usage。覆盖语义=只认最新发送（串行下与先到先得等价，
   * 非串行下更安全：旧请求可能已被重试/替代）。
   *
   * @param stateKey 会话状态键
   * @param rawEstimatedTokens 本请求「system+tools+视图」口径未校准估算
   * @param modelKey 校准分键
   */
  private freezeUsagePair(stateKey: string, rawEstimatedTokens: number, modelKey: string): void {
    const state = this.states.get(stateKey) ?? {};
    if (state.pendingUsagePair) {
      console.warn(
        `[ctx-pair] overwrite unconsumed pair: state=${stateKey} seq=${state.pendingUsagePair.seq} rawEst=${state.pendingUsagePair.rawEstimatedTokens}（旧 pair 作废；随后到达的 usage 归属不确定，下一个 usage 同样丢样）`,
      );
    }
    const seq = (state.pairSeq ?? 0) + 1;
    this.states.set(stateKey, {
      ...state,
      // 覆盖丢样（评审 M8，2026-11-08）：覆盖说明存在并发装配/未发送请求，随后到达的
      // usage 可能属于被覆盖的旧请求——与其错配进 EMA 成毒样本，不如丢掉这一个样本。
      // 只在**实际发生覆盖**时标 orphaned；下一轮正常冻结（无覆盖不标）恢复收集。
      pendingUsagePair: {
        rawEstimatedTokens,
        modelKey,
        seq,
        ...(state.pendingUsagePair ? { orphaned: true } : {}),
      },
      pairSeq: seq,
      lastModelKey: modelKey,
    });
  }

  /**
   * 每轮结束后更新状态
   *
   * 使用 LLM 返回的真实 usage 校准 token 估算：把（实测 prompt, 请求口径估算）样本
   * 送入 ContextSizeLedger（P1-a，ratio 按 model 分键）。
   *
   * 配对纪律（2026-11-07）：分母只能是**本请求** assemble 冻结的 pendingUsagePair，
   * 消费即清；缺对丢样，绝不拿旧估算/旧实测凑对（错位对是毒 ratio 样本与毒锚的源头）。
   */
  async afterStep(params: AfterStepParams): Promise<void> {
    const { sessionId, agentId, usage } = params;

    const stateKey = compactStateKey(sessionId, agentId);
    const state = this.states.get(stateKey) ?? {};
    // 消费配对槽（读后即清）：无论本步有无 usage，槽只属于产生它的那个请求
    const pair = state.pendingUsagePair;
    if (pair) {
      const { pendingUsagePair: _consumed, ...rest } = state;
      this.states.set(stateKey, rest);
    }

    if (!usage) return;

    // 真实 prompt tokens（provider 报告优先，分项和兜底——与展示口径同源）
    const promptActual =
      usage.inputReportedTokens ??
      usage.inputUncachedTokens + usage.inputCachedTokens + usage.inputCacheWriteTokens;

    // 缺对丢样：本请求没有冻结估算（或已被消费）时不喂样本——错配样本比少一个样本更糟。
    // 有 usage 却无对 = 外来 usage（摘要/子请求冒名）或漏写槽的信号，如实告警留破案线索。
    if (!pair || !(pair.rawEstimatedTokens > 0) || !(promptActual > 0)) {
      if (promptActual > 0) {
        console.warn(
          `[ctx-pair] usage without pair: session=${sessionId} actual=${promptActual}（丢样——疑似外来 usage 或漏写槽）`,
        );
      }
      return;
    }
    // 覆盖丢样（评审 M8）：pair 曾覆盖未消费的旧槽——本 usage 可能属于被覆盖的旧请求，
    // 归属不确定即丢样（宁缺不错配）；下一轮正常冻结恢复收集
    if (pair.orphaned) {
      console.warn(
        `[ctx-pair] drop orphaned pair: session=${sessionId} seq=${pair.seq} actual=${promptActual}（覆盖后首个 usage 归属不确定，丢样）`,
      );
      return;
    }

    // 全样本审计（2026-11-08）：正常样本也打——错位家族（0.085/0.258）破案的盲区
    // 就是 accepted 样本零日志，出事时只能看到被门拒的残影。
    console.log(
      `[ctx-pair] session=${sessionId} seq=${pair.seq} model=${pair.modelKey} raw=${pair.rawEstimatedTokens} actual=${promptActual} ratio=${(promptActual / pair.rawEstimatedTokens).toFixed(3)}`,
    );

    // P1-a：校准样本入台账——分母 = 本请求冻结的请求口径未校准估算，分子 = provider 实测。
    // ratio 按 model 分键跨 session 共享。
    const verdict = this.sizeLedger.observe(pair.modelKey, promptActual, pair.rawEstimatedTokens, {
      sessionId,
    });
    // 降级 B 锚（arch §10.16，评审 F3）：{actual, raw} 同请求同源冻结成对写入——
    // 冻结门=「在门内入账」的对（accepted/clamped）：clamped 是合法极端内容的锚
    // （F1 冷锚定语义：极端样本不进 EMA 决策，但同请求实测对可锚定外推）；
    // 被拒/重锚样本（证据流敌对或错位对）不得冻结。配对槽已保证同请求同源，
    // 毒对从结构上进不来——消费侧不再按比率带拒锚（会误杀 ratio 远离 1 的合法内容）。
    if (verdict === 'accepted' || verdict === 'clamped') {
      this.states.set(stateKey, {
        ...this.states.get(stateKey),
        lastUsageAnchor: {
          actual: promptActual,
          raw: pair.rawEstimatedTokens,
          modelKey: pair.modelKey,
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
  const lastGenuineUserIdx = lastGenuineUserIndex(messages);
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

/**
 * 最后一条「真实 user 消息」的下标（turn 起点标识）。
 *
 * 「真实 user」= 无 agentId 归因，且非引擎载体（含 `engineHint` reliability 注入）。
 * 历史 append-only，该下标在同 turn 内稳定，可作 turn key（overflow 每 turn 限一次用）。
 *
 * @param messages - 全量消息
 * @returns 下标；无真实 user 时返回 -1
 */
export function lastGenuineUserIndex(messages: Message[]): number {
  let lastGenuineUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // 「真实 user」收紧：agentId 归因的 user（appendCommandDiscourse）不重置边界，
    // 载体过滤走唯一谓词 isTurnAnchor
    if (msg.agentId) continue;
    if (!isTurnAnchor(msg)) continue;
    lastGenuineUserIdx = i;
  }
  return lastGenuineUserIdx;
}
