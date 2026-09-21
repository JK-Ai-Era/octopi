/**
 * 产品 Observer 通道 — 配置与 Run 观测 DTO
 *
 * 目的：开发/测试时观察 Run 现场（Scope / messages / timeline）。
 * 与 EventBus 分工：EventBus 做协调广播；Observer 负责打包可检视快照。
 * 与 Core Observer（metrics/trace）不同子域。
 * 总开关 = `level`：off（**生产/嵌入缺省**）=关；summary/full=开。
 * message 全文只认 payload.messageFullText && retention.messagesPerRun==='full'。
 */

import type { ContentBlock } from '../../core/types.js';
import type { ToolCall, ToolResult } from '../../core/types.js';
import type { Message } from '../../core/types.js';

/** Observer 观察通道 id */
export type ObserverChannelId =
  | 'run.scope'
  | 'run.messages'
  | 'run.timeline'
  | 'run.guard'
  | 'context.layers'
  | 'context.compact'
  | 'context.llm'
  | 'tool.effect'
  | 'security'
  | 'memory';

/** 粒度：off 不采集；summary 仅元数据；full 含可选全文 */
/**
 * Observer 观察档位（配置里唯一的总开关 + 深度预设）
 *
 * - `off`：关闭观测（等价旧 enabled=false）
 * - `summary`：开观测；预设「有现场、无 message 全文」
 * - `full`：开观测；预设「允许 message 全文」
 *
 * 显式 `payload` / `retention` / `channels` **覆盖**预设。
 * message 全文只认 `payload.messageFullText && retention.messagesPerRun==='full'`，
 * **不再**与 level 做 OR。
 */
export type ObserverLevel = 'off' | 'summary' | 'full';

/** 产品 Observer 配置（octopi.json → observer）
 *
 * 总开关由 `level` 表达：`off` = 关；`summary`/`full` = 开。不再单独配置 `enabled`。
 */
export interface ObserverConfig {
  /** 档位：off=关闭；summary/full=开启（深度预设不同） */
  level?: ObserverLevel;
  /** 分通道覆盖；未列出的按 level 预设 */
  channels?: Partial<Record<ObserverChannelId, boolean>>;
  /** 正文类 payload 开关 */
  payload?: {
    layerContent?: boolean;
    layerPreview?: boolean;
    messageFullText?: boolean;
    streamDelta?: boolean;
    modelRequest?: boolean;
  };
  retention?: {
    runsPerSession?: number;
    timelineEvents?: number;
    /** full = entry/final 全文；summary-only = 仅计数 */
    messagesPerRun?: 'full' | 'summary-only';
  };
  /** 是否暴露 Observer/Run 调试 REST */
  webPanel?: boolean;
  /** 观测失败是否只 warn、不打断 run */
  failOpen?: boolean;
}

/** 规范化后的运行时配置（`enabled` 由 level 推导，仅内部使用） */
export interface ResolvedObserverConfig {
  /** 推导：level !== 'off' */
  enabled: boolean;
  level: ObserverLevel;
  channels: Record<ObserverChannelId, boolean>;
  payload: {
    layerContent: boolean;
    layerPreview: boolean;
    messageFullText: boolean;
    streamDelta: boolean;
    modelRequest: boolean;
  };
  retention: {
    runsPerSession: number;
    timelineEvents: number;
    messagesPerRun: 'full' | 'summary-only';
  };
  webPanel: boolean;
  failOpen: boolean;
}

/**
 * 未写 observer 时的解析结果 = level 预设 `off`
 * （生产/嵌入缺省不采集；开发在 octopi.json 显式 summary/full）
 */
export const DEFAULT_OBSERVER_CONFIG: ResolvedObserverConfig = {
  enabled: false,
  level: 'off',
  channels: {
    'run.scope': false,
    'run.messages': false,
    'run.timeline': false,
    'run.guard': false,
    'context.layers': false,
    'context.compact': false,
    'context.llm': false,
    'tool.effect': false,
    'security': false,
    'memory': false,
  },
  payload: {
    layerContent: false,
    layerPreview: false,
    messageFullText: false,
    streamDelta: false,
    modelRequest: false,
  },
  retention: {
    runsPerSession: 3,
    timelineEvents: 200,
    messagesPerRun: 'summary-only',
  },
  webPanel: false,
  failOpen: true,
};

const ALL_CHANNELS: ObserverChannelId[] = [
  'run.scope',
  'run.messages',
  'run.timeline',
  'run.guard',
  'context.layers',
  'context.compact',
  'context.llm',
  'tool.effect',
  'security',
  'memory',
];

/** level 预设（随后被用户显式字段覆盖） */
function levelPreset(level: ObserverLevel): {
  enabled: boolean;
  channels: Record<ObserverChannelId, boolean>;
  payload: ResolvedObserverConfig['payload'];
  retention: ResolvedObserverConfig['retention'];
} {
  // summary/full：已实现通道默认开（含 security / memory / tool.effect）
  const channels = {
    'run.scope': true,
    'run.messages': true,
    'run.timeline': true,
    'run.guard': true,
    'context.layers': true,
    'context.compact': true,
    'context.llm': false,
    'tool.effect': true,
    security: true,
    memory: true,
  } as Record<ObserverChannelId, boolean>;

  const payload: ResolvedObserverConfig['payload'] = {
    layerContent: true,
    layerPreview: true,
    messageFullText: false,
    streamDelta: false,
    modelRequest: false,
  };
  const retention: ResolvedObserverConfig['retention'] = {
    runsPerSession: 3,
    timelineEvents: 200,
    messagesPerRun: 'summary-only',
  };

  if (level === 'off') {
    for (const id of ALL_CHANNELS) channels[id] = false;
    return { enabled: false, channels, payload, retention };
  }

  if (level === 'full') {
    payload.messageFullText = true;
    retention.messagesPerRun = 'full';
    channels['context.llm'] = true;
    return { enabled: true, channels, payload, retention };
  }

  // summary
  return { enabled: true, channels, payload, retention };
}

/**
 * 规范化 Observer 配置（方案 A）
 *
 * 顺序：level 预设 → 用户显式 channels/payload/retention 覆盖。
 * `enabled` **仅**由 level 推导：`off` → false；`summary`/`full` → true。
 * `webPanel` 跟 level 走：`off` 时强制关闭；开启档位下默认 true，可显式 false。
 *
 * @param input - 用户配置（可空；空 = level off，生产/嵌入缺省不采集）
 * @returns 运行时配置
 */
export function resolveObserverConfig(input?: ObserverConfig): ResolvedObserverConfig {
  const level: ObserverLevel = input?.level ?? 'off';
  const preset = levelPreset(level);

  const channels = { ...preset.channels } as Record<ObserverChannelId, boolean>;
  if (input?.channels) {
    for (const id of ALL_CHANNELS) {
      const v = input.channels[id];
      if (typeof v === 'boolean') channels[id] = v;
    }
  }

  const payload: ResolvedObserverConfig['payload'] = { ...preset.payload };
  if (input?.payload) {
    if (typeof input.payload.layerContent === 'boolean') {
      payload.layerContent = input.payload.layerContent;
    }
    if (typeof input.payload.layerPreview === 'boolean') {
      payload.layerPreview = input.payload.layerPreview;
    }
    if (typeof input.payload.messageFullText === 'boolean') {
      payload.messageFullText = input.payload.messageFullText;
    }
    if (typeof input.payload.streamDelta === 'boolean') {
      payload.streamDelta = input.payload.streamDelta;
    }
    if (typeof input.payload.modelRequest === 'boolean') {
      payload.modelRequest = input.payload.modelRequest;
    }
  }

  const retention: ResolvedObserverConfig['retention'] = { ...preset.retention };
  if (input?.retention) {
    if (typeof input.retention.runsPerSession === 'number') {
      retention.runsPerSession = input.retention.runsPerSession;
    }
    if (typeof input.retention.timelineEvents === 'number') {
      retention.timelineEvents = input.retention.timelineEvents;
    }
    if (input.retention.messagesPerRun === 'full' || input.retention.messagesPerRun === 'summary-only') {
      retention.messagesPerRun = input.retention.messagesPerRun;
    }
  }

  // 总闸只认 level：off=关，其余=开
  const enabled = level !== 'off';
  // webPanel 跟 level：off 强制关；开启时默认 true，允许显式 false
  const webPanel = enabled && (typeof input?.webPanel === 'boolean' ? input.webPanel : true);

  return {
    enabled,
    level,
    channels,
    payload,
    retention,
    webPanel,
    failOpen: typeof input?.failOpen === 'boolean' ? input.failOpen : true,
  };
}

/**
 * 判断某通道是否应采集
 *
 * @param cfg - 已规范化配置
 * @param channel - 通道 id
 * @returns 是否启用
 */
export function isChannelEnabled(cfg: ResolvedObserverConfig, channel: ObserverChannelId): boolean {
  return cfg.enabled && cfg.channels[channel] === true;
}

/**
 * 是否允许消息全文深拷贝
 *
 * **只**由 payload + retention 决定（level 仅通过预设影响这两项）。
 *
 * @param cfg - 已规范化配置
 * @returns 是否采集全文
 */
export function shouldCaptureMessageFullText(cfg: ResolvedObserverConfig): boolean {
  return (
    isChannelEnabled(cfg, 'run.messages') &&
    cfg.payload.messageFullText === true &&
    cfg.retention.messagesPerRun === 'full'
  );
}

// ── Run 观测 DTO ──

export type RunMessageViewRole = 'user' | 'assistant' | 'system' | 'tool';

/** 单条 Run message 的 UI 视图 */
export interface RunMessageView {
  index: number;
  role: RunMessageViewRole;
  agentId?: string;
  timestamp?: number;
  content?: string | ContentBlock[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  metadata?: Record<string, unknown>;
  /** 中栏对话是否会隐藏本条 */
  hiddenFromChat?: boolean;
  contentChars?: number;
  /** 摘要模式下的截断预览 */
  contentPreview?: string;
}

export type RunMessagesPhase = 'entry' | 'final';
export type RunMessagesView = 'workspace' | 'llm';

export interface RunMessagesSummary {
  count: number;
  byRole: Record<string, number>;
  systemPromptCount: number;
  contextSummaryCount: number;
  hiddenFromChatCount: number;
  chars: number;
  agentIds: string[];
}

/** Guard / RunMetricsCollector 投影 */
export interface RunGuardMetricsView {
  sessionId?: string;
  agentId?: string;
  iteration: number;
  totalToolCalls: number;
  /** 诊断 nominal Σ（非 spend hard） */
  nominalTotalTokens: number;
  elapsedMs: number;
  consecutiveErrors: number;
  consecutiveSameTool: number;
  noopStreak: number;
  hasProgress: boolean;
  uniqueTools: string[];
  recentTools: Array<{ name: string; success: boolean }>;
  recoveryCount: number;
  /** P1 cache-aware 账本 */
  usageLedger?: import('../accounting/usage-ledger.js').UsageLedgerSnapshot;
  /** P4 session 级账本 */
  sessionLedger?: import('../accounting/session-ledger.js').SessionLedgerSnapshot;
  /** budget / run_guard 事件补充 */
  budgetExceededReason?: string;
  /** P2 wrap-up 状态 */
  wrapUpActive?: boolean;
  wrapUpReason?: 'context' | 'policy';
  wrapUpTurnsRemaining?: number;
  guardStoppedReason?: string;
  guardRecovered?: { reason: string; actions: string[] };
}

/** entry → final messages 简要 diff */
export interface RunMessagesDiff {
  entryCount: number;
  finalCount: number;
  added: Array<{ index: number; role: string; contentChars?: number; hiddenFromChat?: boolean; source?: string }>;
  removedCount: number;
  notes: string;
}

export interface RunMessagesSnapshot {
  sessionId: string;
  agentId?: string;
  runId?: string;
  runCapturedAt?: number;
  view: RunMessagesView;
  phase: RunMessagesPhase;
  summary: RunMessagesSummary;
  /** full 配置下才有 */
  messages?: RunMessageView[];
  notes?: string;
}

export interface RunToolRuntimeView {
  sessionId: string;
  agentId: string;
  messagesCount: number;
  cwd?: string;
  isolation?: string;
}

export interface RunScopeView {
  sessionId: string;
  agentId: string;
  runId?: string;
  agentRevision?: string;
  systemPromptChars?: number;
  systemPromptPreview?: string;
  /** level=full 或 payload 允许时才有全文 */
  systemPromptFull?: string;
  toolRuntime?: RunToolRuntimeView;
  resolvedModel?: {
    modelName?: string;
    providerId?: string;
    contextWindow?: number;
  };
  capturedAt: number;
}

export interface RunTimelineEventView {
  type: string;
  timestamp: number;
  agentId?: string;
  toolCallId?: string;
  toolName?: string;
  hasError?: boolean;
  durationMs?: number;
  reason?: string;
  usage?: import('../../core/types/turn.js').TokenUsage;
}

export interface RunLifecycleView {
  startedAt?: number;
  endedAt?: number;
  endReason?: string;
  durationMs?: number;
  turns?: number;
  toolCalls?: number;
  error?: string;
}

/** security 通道：结构化安全事件投影 */
export interface RunSecurityEventView {
  type: string;
  timestamp: number;
  severity?: string;
  description?: string;
  source?: string;
  toolName?: string;
  action?: string;
  violationTypes?: string[];
  count?: number;
}

/** memory 通道：本 run 内 memory_store / memory_search 只读摘要（E3 不写外库） */
export interface RunMemoryActivityView {
  stores: number;
  searches: number;
  storedOk: number;
  rejected: number;
  superseded: number;
  searchHits: number;
  entries: Array<{
    kind: 'store' | 'search';
    timestamp: number;
    toolName: string;
    success: boolean;
    memoryId?: string;
    memoryType?: string;
    status?: string;
    propositionPreview?: string;
    supersededId?: string | null;
    rejectReason?: string;
    query?: string;
    resultCount?: number;
  }>;
}

/** tool.effect 通道：I5 效应面投影 */
export interface RunToolEffectView {
  sessionId: string;
  agentId: string;
  runId?: string;
  cwd?: string;
  isolation?: string;
  tools: Array<{
    name: string;
    calls: number;
    errors: number;
    lastDurationMs?: number;
  }>;
  notes?: string[];
}

/** 单次 Run 的观测投影（WS/REST 摘要；全文经 messages REST） */
export interface RunObservatorySnapshot {
  sessionId: string;
  agentId?: string;
  runId: string;
  scope: RunScopeView;
  messagesSummary?: RunMessagesSummary;
  /** LLM 实际输入摘要（ContextEngine 出口） */
  llmSummary?: RunMessagesSummary;
  llmEstimatedTokens?: number;
  /** Guard / RunMetrics */
  guardMetrics?: RunGuardMetricsView;
  /** entry → final diff */
  messagesDiff?: RunMessagesDiff;
  lifecycle?: RunLifecycleView;
  timeline?: RunTimelineEventView[];
  /** security 通道 */
  securityEvents?: RunSecurityEventView[];
  /** memory 通道（只读投影） */
  memoryActivity?: RunMemoryActivityView;
  /** tool.effect 通道（I5） */
  toolEffect?: RunToolEffectView;
  /** 通道/配置诊断 */
  observer: {
    enabled: boolean;
    level: ObserverLevel;
    webPanel: boolean;
  };
}

/** message 摘要统计 */
export function summarizeMessages(
  messages: Message[],
  opts?: { maxPreviewChars?: number },
): { summary: RunMessagesSummary; views: RunMessageView[] } {
  const maxPreview = opts?.maxPreviewChars ?? 200;
  const byRole: Record<string, number> = {};
  const agentIds = new Set<string>();
  let systemPromptCount = 0;
  let contextSummaryCount = 0;
  let hiddenFromChatCount = 0;
  let chars = 0;

  const views: RunMessageView[] = messages.map((m, index) => {
    const role = (m.role ?? 'user') as RunMessageViewRole;
    byRole[role] = (byRole[role] ?? 0) + 1;
    if (m.agentId) agentIds.add(m.agentId);
    const source = (m.metadata as { source?: string } | undefined)?.source;
    if (m.role === 'system' && source === 'systemPrompt') systemPromptCount += 1;
    if (source === 'contextSummary') contextSummaryCount += 1;
    const hidden = isHiddenFromChat(m);
    if (hidden) hiddenFromChatCount += 1;
    const text = extractMessageText(m.content);
    chars += text.length;
    return {
      index,
      role,
      agentId: m.agentId,
      timestamp: m.timestamp,
      metadata: m.metadata,
      toolCalls: m.toolCalls,
      toolResults: m.toolResults,
      hiddenFromChat: hidden,
      contentChars: text.length,
      contentPreview: text.slice(0, maxPreview),
    };
  });

  return {
    summary: {
      count: messages.length,
      byRole,
      systemPromptCount,
      contextSummaryCount,
      hiddenFromChatCount,
      chars,
      agentIds: [...agentIds],
    },
    views,
  };
}

/**
 * 是否对话历史会隐藏（与 ConversationAdapter 同规则，开发观测用）
 *
 * @param msg - 消息
 * @returns 是否隐藏
 */
export function isHiddenFromChat(msg: Pick<Message, 'role' | 'content' | 'metadata'>): boolean {
  if (msg.role !== 'system') return false;
  const source = (msg.metadata as { source?: string } | undefined)?.source;
  if (source === 'systemPrompt') return true;
  const text = extractMessageText(msg.content);
  return (
    text.length > 200 &&
    /AGENTS\.md|Session Startup|Operating Instructions|Agent Persona/i.test(text)
  );
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: unknown) => (b as { type?: string })?.type === 'text')
      .map((b: unknown) => String((b as { text?: string }).text ?? ''))
      .join('');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * 为 UI 填充 message 全文（full 模式）
 *
 * @param views - 摘要视图列表
 * @param messages - 原始消息
 * @returns 带 content 的视图
 */
export function attachFullContent(views: RunMessageView[], messages: Message[]): RunMessageView[] {
  return views.map((v) => {
    const m = messages[v.index];
    if (!m) return v;
    return { ...v, content: m.content };
  });
}

function cloneUnknown<T>(value: T): T {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    // 不可结构化克隆的对象：保留引用（观测 fail-open，不阻断）
    return value;
  }
}

/**
 * 深拷贝消息数组（观测快照，避免 run 内原地修改污染）
 *
 * content / tool 参数 / metadata 走 structuredClone。
 *
 * @param messages - 源消息
 * @returns 结构化拷贝
 */
export function cloneMessages(messages: Message[]): Message[] {
  return messages.map((m) => ({
    ...m,
    content: cloneUnknown(m.content),
    toolCalls: m.toolCalls
      ? m.toolCalls.map((t) => ({ ...t, arguments: cloneUnknown(t.arguments) }))
      : undefined,
    toolResults: m.toolResults ? m.toolResults.map((t) => cloneUnknown(t)) : undefined,
    metadata: m.metadata ? cloneUnknown(m.metadata) : undefined,
  }));
}

/**
 * LLMMessage（provider 边界）→ 摘要统计
 *
 * @param messages - assemble 出口消息
 * @returns summary
 */
export function summarizeLlmMessages(messages: Array<{
  role: string;
  content?: unknown;
}>): RunMessagesSummary {
  const byRole: Record<string, number> = {};
  let chars = 0;
  for (const m of messages) {
    const role = m.role || 'unknown';
    byRole[role] = (byRole[role] ?? 0) + 1;
    chars += extractMessageText(m.content).length;
  }
  return {
    count: messages.length,
    byRole,
    systemPromptCount: byRole.system ?? 0,
    contextSummaryCount: 0,
    // LLM 出口视图无「对话 UI 隐藏」语义；不把 system 条数冒充 hidden
    hiddenFromChatCount: 0,
    chars,
    agentIds: [],
  };
}

/**
 * entry → final 简要 diff（按下标对齐，只报告 final 侧新增）
 *
 * @param entry - 入口消息（或其视图）
 * @param final - 结束消息
 * @returns RunMessagesDiff
 */
export function buildRunMessagesDiff(
  entry: Message[] | RunMessageView[],
  final: Message[] | RunMessageView[],
): RunMessagesDiff {
  const entryCount = entry.length;
  const finalCount = final.length;
  const added: RunMessagesDiff['added'] = [];
  for (let i = entryCount; i < finalCount; i++) {
    const item = final[i]!;
    const asView = item as RunMessageView;
    const asMsg = item as Message;
    const source = (asView.metadata ?? asMsg.metadata) as { source?: string } | undefined;
    const content =
      'content' in item && item.content != null
        ? extractMessageText(item.content)
        : asView.contentPreview ?? '';
    added.push({
      index: i,
      role: asView.role ?? asMsg.role ?? 'unknown',
      contentChars: content.length,
      hiddenFromChat:
        asView.hiddenFromChat ??
        (asMsg.role ? isHiddenFromChat(asMsg) : undefined),
      source: source?.source,
    });
  }
  return {
    entryCount,
    finalCount,
    added,
    removedCount: Math.max(0, entryCount - finalCount),
    notes:
      finalCount > entryCount
        ? `final 比 entry 多 ${finalCount - entryCount} 条`
        : finalCount === entryCount
          ? 'entry 与 final 条数相同'
          : `final 比 entry 少 ${entryCount - finalCount} 条（可能被 Guard 截断）`,
  };
}
