/**
 * ContextLayer — System 内容契约（产品八层之 1–7）
 *
 * @layer harness/context
 *
 * 与 ContextEngine 的分工：
 * - ContextLayer / ContextAssembler：决定 **system prompt 里有什么**
 *   （Wisdom / Persona / Skill / Knowledge / Cognition / Memory / Runtime）
 * - ContextEngine：决定 **消息窗口怎么压**
 *   （Information 层，选择 / 路由 / 压缩）
 *
 * 契约优先：本文件只定义层接口与装配输入输出。
 * 各层业务实现（检索、打分、落盘）可在后续迭代中逐个替换，
 * 不改变本契约。
 */

import type { Message } from '@octopi-agent/core/types.js';
import { extractUserMessageText, isTurnStartContent } from './turn-envelope.js';

// ── 层标识 ──

/**
 * System prompt 内容层（契约 id）
 *
 * 排列顺序：Wisdom → Persona → Skill → Knowledge → Cognition → Memory → Runtime。
 *
 * **产品八层 = 本契约 7 层（1–7，含 Runtime）+ Information（第 8 层，消息窗口）。**
 * Runtime 是产品第 7 层（system 侧，归属 Run：injectedContext / tasks / guidance）。
 * Information 是产品第 8 层，由 ContextEngine 管消息窗口，**不是** ContextLayer。
 */
export type ContextLayerId =
  | 'wisdom'
  | 'persona'
  | 'skill'
  | 'knowledge'
  | 'cognition'
  | 'memory'
  | 'runtime';

/**
 * 默认层顺序（数字越小越靠 system prompt 前部）
 *
 * 注意：`defaultShare` **不再**驱动 Assembler 全局配额。
 * 预算默认只控 system 总量 + priority 竞争；
 * 仅 `DefaultContextAssemblerConfig.layerShares` / assemble 参数里显式配置的层
 * 才有硬顶（floor(contentBudget × share)）。
 */
export const LAYER_ORDER: Record<ContextLayerId, number> = {
  wisdom: 10,
  persona: 20,
  skill: 30,
  knowledge: 40,
  cognition: 50,
  memory: 60,
  /** 会话任务 / 子系统 guidance 等每轮动态注入，靠近对话侧 */
  runtime: 70,
};

/** 默认层优先级（预算竞争时越大越先保留） */
export const LAYER_PRIORITY: Record<ContextLayerId, number> = {
  persona: 100,
  runtime: 80,
  wisdom: 70,
  skill: 60,
  knowledge: 40,
  memory: 30,
  cognition: 20,
};

/**
 * 历史默认 share（文档/UI 参考；Assembler 默认不读此表做配额）
 *
 * 需要单层硬顶时，在 contextAssembler.layerShares 配置对应层。
 */
export const LAYER_DEFAULT_SHARE: Record<ContextLayerId, number> = {
  persona: 0.35,
  wisdom: 0.12,
  skill: 0.15,
  knowledge: 0.12,
  memory: 0.10,
  cognition: 0.06,
  runtime: 0.10,
};

// ── 装配上下文 ──

/**
 * 每层 assemble 时可见的会话视图
 *
 * 注意：这里 **不** 含完整工具列表与 token 全局状态之外的引擎内部结构，
 * 层实现只依赖消息与显式预算，便于单独测试与替换。
 */
export interface LayerAssembleContext {
  sessionId: string;
  agentId?: string;
  /** 当前完整消息历史（含本轮用户输入） */
  messages: Message[];
  /**
   * 检索用查询文本。
   * 默认由 Assembler 从最近用户消息提取；层可忽略。
   */
  query?: string;
  /** 本层本轮可用 token 预算 */
  tokenBudget: number;
  /** system prompt 总 token 预算（供需要全局视野的层参考） */
  systemBudget: number;
  signal?: AbortSignal;
}

// ── 层输出 ──

/** 单层产出 */
export interface LayerContent {
  layerId: ContextLayerId;
  /** 已格式化的注入正文（含标题时由层自行决定） */
  text: string;
  /** 正文估算 token（层负责填，Assembler 可覆写校准） */
  tokens: number;
  /** 层内截断/丢弃说明（可观测；不进入 system prompt） */
  dropped?: string;
  /** 溯源：文件路径、memory id、skill id 等 */
  sources?: string[];
}

// ── 层接口 ──

/**
 * 装配位置（宪法 E8：缓存稳定前缀）
 *
 * - `system`（缺省）：缓存稳定片段 → system prompt
 * - `snapshot`：每 run 易变快照（Run 作用域 / query 相关择取）→ 消息尾部 content 侧
 */
export type LayerPlacement = 'system' | 'snapshot';

/**
 * ContextLayer — 单层内容提供者
 *
 * 实现约束：
 * - `assemble` 返回 `null`/空 text 表示本层本轮无内容（不算失败）
 * - 层 **不得** 直接改写其他层内容；只产出自己的片段
 * - 层 **不得** 假设自己一定被纳入最终 system（Assembler 可能因预算丢弃）
 */
export interface ContextLayer {
  readonly id: ContextLayerId;
  /** 预算竞争优先级，越大越先保留 */
  readonly priority: number;
  /** system 预算默认份额 [0,1]，启用层之间归一化 */
  readonly defaultShare: number;
  /** 预算不足时是否允许整层丢弃；persona 通常 false */
  readonly droppable: boolean;
  /** system prompt 中的位置（小的在前） */
  readonly order: number;
  /**
   * 装配位置（宪法 E8）。缺省 `system`。
   *
   * 跨 run 可变的内容（query 相关检索择取、datetime、tasks/guidance 等）
   * 必须标 `snapshot`：不得进入 system prompt 前缀，由调用方作为本轮
   * 易变快照在消息尾部（content 侧）送达。
   */
  readonly placement?: LayerPlacement;

  /**
   * 变更指纹。与上次不同则强制重新 assemble；返回 null 表示每轮都重算。
   *
   * 典型：
   * - persona：文件 path:mtime:size
   * - skill：技能列表 id+desc 摘要
   * - memory/knowledge：可每轮重算（返回 null）
   */
  fingerprint?(ctx: LayerAssembleContext): Promise<string | null> | string | null;

  /** 产出本层内容；空则跳过 */
  assemble(ctx: LayerAssembleContext): Promise<LayerContent | null>;
}

// ── 装配结果 ──

/** 装配清单（可观测，不进入模型输入） */
export interface LayerManifestEntry {
  id: ContextLayerId;
  /** 装配位置（E8）；缺省 system */
  placement?: LayerPlacement;
  included: boolean;
  tokens: number;
  /** 本层硬顶 token（仅 layerShares 配置过的层）；无单层上限时缺省 */
  budgetTokens?: number;
  priority: number;
  order: number;
  /** 本轮装配时该层的 droppable（以 ContextLayer 实例为准） */
  droppable?: boolean;
  /** 未纳入或截断的原因 */
  reason?: string;
  dropped?: string;
  sources?: string[];
  /** 层正文截断预览（仅 includeLayerPreview 时写入；不进入模型输入） */
  preview?: string;
  /**
   * 层正文全文（includeLayerContent 时写入；供 Web 检查器点选查看）
   * 不进入模型输入。WS 广播会剥离此字段，仅 REST 提供。
   */
  content?: string;
}

export interface AssembleManifest {
  sessionId: string;
  /** system 总预算 */
  systemBudget: number;
  /** 结构预留（分隔符等） */
  structureReserve?: number;
  /** 实际使用的 token（system 组） */
  usedTokens: number;
  /** 易变快照组实际使用的 token（E8；无 snapshot 层时缺省） */
  usedSnapshotTokens?: number;
  /**
   * 显式配置的 layerShares 硬顶比例（未配置的层不出现）
   * 不再表示「启用层归一化后的全局配额」
   */
  shares: Partial<Record<ContextLayerId, number>>;
  layers: LayerManifestEntry[];
}

export interface SystemAssembleResult {
  /** 组装后的 system prompt（不含消息窗口内容） */
  systemPrompt: string;
  manifest: AssembleManifest;
}

// ── 装配器 ──

export interface ContextAssembler {
  /**
   * 组装 system prompt
   *
   * @param params.layers - 本轮启用的层（顺序无关，Assembler 按 order 排序）
   */
  assemble(params: ContextAssembleParams): Promise<SystemAssembleResult>;
}

export interface ContextAssembleParams {
  sessionId: string;
  agentId?: string;
  messages: Message[];
  /** system prompt 总 token 预算 */
  systemBudget: number;
  /** 启用层；缺省空数组则产出空 system */
  layers: ContextLayer[];
  /** 检索查询；缺省从 messages 提取 */
  query?: string;
  /**
   * 单层硬顶比例（覆盖/合并构造器配置）：id → contentBudget 比例。
   * 仅配置的层生效；未配置层无单层上限。
   */
  layerShares?: Partial<Record<ContextLayerId, number>>;
  /** 全局宪法 preamble；与层竞争预算无关，拼在 system 最前 */
  constitutionPreamble?: string;
  tokenEstimator?: {
    estimateText(text: string): number;
  };
  signal?: AbortSignal;
}

// ── 工具函数 ──

/** 纯应答/推进语：本身无检索语义，需要回看上文 */
const ACK_LAYER_QUERY_RE =
  /^(好|好的|好呀|好吧|嗯+|行|可以|继续|接着|然后呢?|下一步|收到|开始吧?|没问题|就这样|ok+|okay|yes|yeah|yep|go(\s+on)?|proceed)[\s!！。.~～]*$/i;

/**
 * 引擎托管的 user 角色插槽（快照/grounding/附件/摘要）——不是用户发言。
 * 检索 query 只采信真实用户文本；否则上轮快照（含旧记忆择取）会混入 query
 * 造成择取自我强化漂移。
 */
const ENGINE_CARRIER_SOURCES = new Set([
  'runtimeSnapshot',
  'knowledgeGrounding',
  'sessionAttachment',
  'contextSummary',
  /** reliability/steer 注入（wrap-up / planning / noop / truncate notice 等）——非用户发言 */
  'engineHint',
  /** turn 闭标（`<turn_end id/>`）——不是用户发言 */
  'turnEnd',
  /**
   * 引擎主动停止的收口说明（RunGuard / Budget 裁决）。
   *
   * 引擎有权终止 turn，就必须留下用户可见的原因；这条既不是用户发言，
   * 也不进 LLM 上下文（见 DefaultContextEngine.buildLlmMessages）。
   */
  'runStopped',
]);

/**
 * 判断消息 source 是否为引擎载体插槽（非用户发言）
 *
 * @param source - `message.metadata.source`
 * @returns true 表示机器插槽（快照/grounding/附件/摘要）
 */
export function isEngineCarrierSource(source: unknown): boolean {
  return ENGINE_CARRIER_SOURCES.has(source as string);
}

/**
 * schedule notify 便签判定（turn 锚点与 LLM 视图打标共用单源）。
 *
 * producer 见 gateway `setNotify`：借 user 通道落库的机器留言，不开轮、
 * 不跑模型；LLM 视图必须以 `<schedule_notice>` 信封包裹（convertMessage），
 * 不得冒充人话（宪法 Confusables「Machine content vs human speech」）。
 *
 * @param msg - 消息（结构化入参）
 * @returns true = schedule notify 便签
 */
export function isScheduleNotice(msg: {
  metadata?: { delivery?: unknown };
}): boolean {
  return msg.metadata?.delivery === 'notify';
}

/**
 * 轮次锚点判定（turn 边界类消费方：isMidTurn / compact / tool-result-aging）。
 *
 * 能开轮的输入 = 真实用户发言 + `source:'runtime'` 的 activation 唤醒输入
 * （compiler 打标、确实开轮且是该 turn 的输入）；引擎载体插槽与 schedule
 * notify 便签（`delivery:'notify'`）不开轮。2026-10-24 拍板拆分：wake
 * 「开轮但不是人话」——两类消费方各取所需，一个布尔不再混答两个问题。
 *
 * @param msg - 消息（结构化入参，接受 Message 及其裁剪形态）
 * @returns true = 该消息能作为 turn 边界锚点
 */
export function isTurnAnchor(msg: {
  role?: string;
  metadata?: { source?: unknown; delivery?: unknown };
}): boolean {
  if (msg.role !== 'user') return false;
  if (isEngineCarrierSource(msg.metadata?.source)) return false;
  // schedule notify 是机器便签（producer 见 gateway setNotify），不是用户输入
  if (isScheduleNotice(msg)) return false;
  return true;
}

/**
 * turn 边界锚点判定（边界类消费方共用：isMidTurn / compact / tool-result-aging）。
 *
 * isTurnAnchor 基础上剔除 **agentId 归因** 的 user 消息（appendCommandDiscourse：
 * slash 命令话语、多 agent 共线记录）——它们不是主对话发言，不得推进任何 turn
 * 边界。此前 tool-result-aging 用裸 isTurnAnchor 各自判边界，命令话语会误推进
 * 老化边界（与 isMidTurn/compact 不一致，2026-11-20 收敛到本谓词）。
 *
 * 注意各消费方**边界语义有意不同**，只是共享锚点定义：aging 取 run 起点
 * （{@link currentRunStartAnchorIndex}，插话不推进）；compact/isMidTurn 仍取
 * 最近锚点（turn 语义——压缩门控本就是 turn 域）。勿把「谓词统一」误读为
 * 「边界统一」（评审 del-5ca70159 P2-3）。
 *
 * @param msg - 消息（结构化入参，接受 Message 及其裁剪形态）
 * @returns true = 可作为 turn 边界锚点
 */
export function isTurnBoundaryAnchor(msg: {
  role?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}): boolean {
  return !msg.agentId && isTurnAnchor(msg);
}

/**
 * 当前 run 起点锚点下标（tool-result-aging 的保护边界）。
 *
 * 「当前 run 永不老化」按 **run 起点** 计（2026-11-20 拍板）：同一 run 的
 * 插话 / 接续注入（v0.95 起同 run 多 turn）不推进老化边界，任务中途的工具
 * 工作数据不被降级。锚点携带 `metadata.runId`（runner 在 bakeTurnStart 打标）：
 * - 最后锚点无 runId（升级前历史）→ 回落 turn 语义（= 最后锚点，旧行为）；
 * - 回溯遇**无 runId 或不同 runId** 的锚点即停（无归因锚点作 run 分界）。
 *   「即停」而非「跳过」是 write-once 的前提：跳过会让未打标锚点夹在同 run
 *   打标锚点之间时把边界**拉回**（已降级条目回原文、批量段翻转，F1 事故形态；
 *   评审 del-5ca70159 P1-1 反例）。即停保证边界随历史增长单调前进，
 *   最坏只是多保护一段旧数据，永不回退。
 *
 * @param messages - 完整历史消息（按时间序）
 * @returns 当前 run 起点锚点下标；无锚点时 -1
 */
export function currentRunStartAnchorIndex(
  messages: ReadonlyArray<{
    role?: string;
    agentId?: string;
    metadata?: Record<string, unknown>;
  }>,
): number {
  let last = -1;
  for (let i = 0; i < messages.length; i++) {
    if (isTurnBoundaryAnchor(messages[i])) last = i;
  }
  if (last < 0) return -1;
  const runId = messages[last].metadata?.runId;
  if (typeof runId !== 'string' || runId === '') return last;
  let first = last;
  for (let i = last - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isTurnBoundaryAnchor(m)) continue;
    if (m.metadata?.runId !== runId) break; // 无归因或异 run：作 run 分界（单调性前提）
    first = i;
  }
  return first;
}

/**
 * 中止标记锚点 = 某 turn 的用户输入：开轮信封（含 wake 等机器输入），或定形前的
 * 裸用户输入。abort / edit-resend 的截断锚点判定（view 与写路径同口径）。
 *
 * 历史：本谓词曾在 run-host 与 gateway 各存一份手抄（run-host 迁移时声称单一来源，
 * gateway 副本未删）——2026-11-20 合并到本文件，turn 边界类谓词一处收口。
 *
 * @param msg - 待判定消息（abort 标记指向的历史条目）
 * @returns true = 可作为中止 turn 的截断锚点
 */
export function isTurnInput(
  msg:
    | { role?: string; content?: Message['content']; metadata?: Record<string, unknown> }
    | undefined,
): boolean {
  return (
    !!msg &&
    msg.role === 'user' &&
    (isTurnStartContent(msg.content) || isTurnAnchor(msg))
  );
}

/**
 * 人话判定（人类文本类消费方：title / grounding.latestUserText / backfill userTurns）。
 *
 * 只有真实用户创作的文本才是「人话」：引擎载体插槽、schedule notify 便签、
 * `source:'runtime'` 的 activation 唤醒输入（机器提示词）都会污染标题与 grounding 锚点。
 * 注意本谓词**不看 agentId**：isMidTurn 另有「无 agentId 归因」的收紧
 * （多 agent 共线语义），在其调用处叠加。
 *
 * @param msg - 消息（结构化入参，接受 Message 及其裁剪形态）
 * @returns true = 真实用户创作的发言
 */
export function isHumanSpeech(msg: {
  role?: string;
  metadata?: { source?: unknown; delivery?: unknown };
}): boolean {
  if (!isTurnAnchor(msg)) return false;
  // wake 是机器开轮输入：能锚定 turn，但不是人话
  return msg.metadata?.source !== 'runtime';
}

/**
 * 聊天回放隐藏谓词（D9 收敛的唯一真源）。
 *
 * observer `isHiddenFromChat` 与 gateway `ConversationAdapter.isHiddenSystemHistory`
 * 均委托本函数——两份手抄清单曾漂移（observer 漏 3 个 source），收敛后不再各自维护。
 * 语义（D8 拍板后）：
 * - 引擎载体插槽（knowledgeGrounding / sessionAttachment / runtimeSnapshot）与 turn 闭标：
 *   只进 LLM 上下文，不进聊天回放；
 * - `contextSummary` / `engineHint` / `runStopped`：**不隐藏**——渲染为系统提示条
 *   （SystemConversationItem），不冒充用户气泡。`runStopped` 是引擎主动终止 turn
 *   的唯一可见凭证，隐藏它等于允许静默掐断任务；
 * - 托管 systemPrompt 与无 metadata 的历史人格整段注入（长度+关键词启发式）：隐藏。
 *
 * @param input - 消息的 role / metadata.source / 正文文本
 * @returns true = 聊天回放跳过本条
 */
export function isChatReplayHidden(input: {
  role?: string;
  source?: string;
  text: string;
}): boolean {
  if (
    input.source === 'knowledgeGrounding' ||
    input.source === 'sessionAttachment' ||
    input.source === 'runtimeSnapshot' ||
    input.source === 'turnEnd'
  ) {
    return true;
  }
  if (input.role !== 'system') return false;
  if (input.source === 'systemPrompt') return true;
  return (
    input.text.length > 200 &&
    /AGENTS\.md|Session Startup|Operating Instructions|Agent Persona/i.test(input.text)
  );
}

export interface ExtractLayerQueryOptions {
  /**
   * 额外主题线索（会话任务标题/当前步骤等）。
   * **仅在最近用户消息是纯应答或为空时追加**，避免任务主题稀释独立新问题。
   */
  topicHints?: string;
  /** query 总字符上限（默认 600） */
  maxChars?: number;
}

function userMessageText(m: Message): string {
  let text = '';
  if (typeof m.content === 'string') text = m.content;
  else if (Array.isArray(m.content)) {
    text = m.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join(' ');
  }
  // turn_start 信封：检索只采 <user_message>，不采 turn_context picks
  return extractUserMessageText(text);
}

/**
 * 是否无检索语义的短应答（继续/好/可以…）
 *
 * @param text - 最近用户消息
 */
export function isThinLayerQuery(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;
  return ACK_LAYER_QUERY_RE.test(t);
}

/**
 * 从消息提取检索 query。
 *
 * 默认取最近一条用户消息；若其为纯应答（「继续」「好」），回看最多 2 条更早的用户消息，
 * 并追加 `topicHints`（任务 focus）。独立新问题只用本句，不掺任务/上文，避免稀释主题。
 * 引擎载体插槽（快照/grounding/附件/摘要）不算用户发言，一律跳过（防旧记忆择取混入 query）。
 *
 * @param messages - 会话消息（含本轮用户输入）
 * @param options - topicHints / maxChars
 * @returns 检索用文本
 */
export function extractLayerQuery(
  messages: Message[],
  options?: ExtractLayerQueryOptions,
): string {
  const userTexts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && userTexts.length < 3; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const src = (m.metadata as { source?: string } | undefined)?.source;
    if (src && ENGINE_CARRIER_SOURCES.has(src)) continue;
    const text = userMessageText(m).trim();
    if (text) userTexts.push(text);
  }
  if (userTexts.length === 0) {
    return (options?.topicHints ?? '').trim();
  }

  const last = userTexts[0];
  const parts: string[] = [last];
  const thin = isThinLayerQuery(last);
  if (thin) {
    // 纯应答无主题：补上更早的用户意图（最多再 2 条）
    for (let i = 1; i < userTexts.length && parts.length < 3; i++) {
      if (!isThinLayerQuery(userTexts[i]) || i === userTexts.length - 1) {
        parts.push(userTexts[i]);
      }
    }
    const hints = (options?.topicHints ?? '').trim();
    if (hints) {
      parts.push(hints);
    }
  }

  const maxChars = options?.maxChars ?? 600;
  return parts.join('\n').slice(0, maxChars).trim();
}

/** 启用层是否产生非空正文 */
export function hasLayerText(content: LayerContent | null | undefined): content is LayerContent {
  return !!content && content.text.trim().length > 0;
}
