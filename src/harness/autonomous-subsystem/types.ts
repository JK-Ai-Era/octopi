/**
 * Autonomous Subsystem — Core Types
 *
 * 自主子系统的核心类型定义。
 * 五维模型：Sense + Think + Act + Signal + Boundary
 *
 * @module autonomous-subsystem/types
 */

import type { Message, RegisteredTool } from '../../core/types.js';
import type { EventBus, AgentEvent } from '../../core/primitives/event-bus.js';

// ── Signal Action（严格枚举） ──

/**
 * 信号动作
 *
 * 子系统和主系统之间的协议，不可自由发挥。
 * LLM 驱动的子系统通过 JSON 输出表达，非法值按 'no-op' 处理。
 */
export type SignalAction =
  | 'allow'      // 放行（Guardian 场景）
  | 'block'      // 阻断（Guardian 场景）
  | 'degrade'    // 降级（Guardian 场景）
  | 'suggest'    // 建议主系统考虑（Advisor 场景）
  | 'replace'    // 建议替换上下文（Compressor 场景）
  | 'alert'      // 发出警告（Supervisor 场景）
  | 'escalate'   // 请求主系统介入（升级场景）
  | 'no-op';     // 无行动（纯观察场景）

/**
 * 信号优先级（数值越小优先级越高）
 */
export const SIGNAL_PRIORITY: Record<SignalAction, number> = {
  block: 0,
  degrade: 1,
  replace: 2,
  suggest: 3,
  alert: 4,
  allow: 5,
  escalate: 0,  // escalate 和 block 同级——都需要立即处理
  'no-op': 99,
};

// ── Signal（信号） ──

/**
 * 子系统发出的信号
 *
 * Signal 是子系统告知主系统某些情况的方式，但不直接改变主系统的行为。
 */
export interface Signal {
  /** 信号动作（严格枚举） */
  action: SignalAction;
  /** 信号原因（自由文本，人类可读） */
  reason: string;
  /** 置信度 (0-1)，仅 LLM 驱动子系统 */
  confidence?: number;
  /** 附加数据 */
  data?: Record<string, unknown>;
}

/**
 * 信号严重级别
 */
export type SignalSeverity = 'info' | 'advisory' | 'warning' | 'critical';

/**
 * 信号通道
 *
 * - context: 作为上下文信息注入（下次 LLM 调用时生效）
 * - steering: 作为引导消息注入（当前轮次生效）
 * - event: 通过 EventBus 广播（异步，其他子系统可监听）
 * - escalate: 请求主系统介入（当前轮次优先处理）
 */
export type SignalChannel = 'context' | 'steering' | 'event' | 'escalate';

// ── Sense（感知） ──

/**
 * 感知来源
 *
 * - eventBus: 监听系统事件
 * - mainContext: 读取主 Agent 的上下文
 * - external: 外部数据源
 * - schedule: 定时触发
 */
export type SenseSource = 'eventBus' | 'mainContext' | 'external' | 'schedule';

/**
 * 信息隔离级别
 *
 * - isolated: 完全看不到主系统信息（纯自包含）
 * - structured: 只看结构化摘要（防 prompt injection）
 * - partial: 看到部分信息（由 fields 指定）
 * - full: 看到完整信息
 */
export type IsolationLevel = 'isolated' | 'structured' | 'partial' | 'full';

/**
 * 上下文字段类型
 */
export type ContextField =
  | 'task_summary'
  | 'tool_calls'
  | 'tool_results'
  | 'working_directory'
  | 'agent_events'
  | 'session_metadata'
  | 'token_count'
  | 'conversation_history'
  | 'pending_tool_call'
  | 'session_lifecycle';

/**
 * Sense 过滤配置
 */
export interface SenseFilter {
  /** 监听的事件类型（source=eventBus 时） */
  events?: string[];
  /** 声明式条件表达式（如 "turn.count % 10 === 0"） */
  condition?: string;
  /** 代码引用（如 "./handler.ts:shouldExtract"），与 condition 互斥 */
  conditionRef?: string;
  /** 该子系统可能产生的事件类型（用于静态循环检测，LLM 子系统建议声明 ['*']） */
  emits?: string[];
}

/**
 * Sense 配置
 */
export interface SenseConfig {
  source: SenseSource;
  filter?: SenseFilter;
  /** schedule 模式：轮询间隔（毫秒） */
  interval?: number;
  isolation: IsolationLevel;
  /** isolation=partial 时，可见的字段列表 */
  fields?: ContextField[];
}

// ── Think（思考） ──

/**
 * 认知策略
 *
 * - deterministic: 纯规则，确定性输出（不需要 LLM）
 * - heuristic: 经验判断，可能需要 LLM 辅助
 * - deliberative: 深度推理，多步 LLM 调用
 */
export type ThinkStrategy = 'deterministic' | 'heuristic' | 'deliberative';

/**
 * 执行实现方式
 *
 * - code: 纯代码执行
 * - llm: LLM 驱动
 * - hybrid: 代码预处理 + LLM 推理 + 代码后处理
 */
export type ThinkImplementation = 'code' | 'llm' | 'hybrid';

/**
 * Think 配置
 */
export interface ThinkConfig {
  strategy: ThinkStrategy;
  implementation: ThinkImplementation;
  /** 系统提示词（llm / hybrid 模式） */
  systemPrompt?: string;
  /** 模型级别引用（如 "mini"、"standard"、"pro"）或 provider/model 格式 */
  model?: string;
  /** 最大推理轮次（默认 1） */
  maxIterations?: number;
  /** hybrid 模式的预处理函数 */
  preProcess?: (input: SubsystemInput) => Promise<SubsystemInput>;
  /** hybrid 模式的后处理函数 */
  postProcess?: (output: SubsystemOutput) => Promise<SubsystemOutput>;
  /** code 模式的执行函数（可选 deps 参数用于依赖注入） */
  handler?: (input: SubsystemInput, deps?: InjectedDependencies) => Promise<SubsystemOutput>;
}

// ── Act（直接行动） ──

/**
 * Act 模式（必填，不可省略）
 *
 * - block: 阻止某个操作
 * - modify: 直接修改系统状态
 * - inject: 注入新信息到系统中
 * - none: 不直接行动，只发信号
 */
export type ActMode = 'block' | 'modify' | 'inject' | 'none';

/**
 * Act 配置（必填）
 */
export interface ActConfig {
  mode: ActMode;
}

// ── Signal 配置 ──

/**
 * Signal 配置
 */
export interface SignalConfig {
  severity: SignalSeverity;
  channel: SignalChannel[];
}

// ── Boundary（边界） ──

/**
 * 可见性级别
 */
export type VisibilityLevel = 'isolated' | 'structured' | 'partial' | 'full';

/**
 * 权限级别
 *
 * - observe: 只能观察，不能影响
 * - suggest: 可以发信号，不能直接行动
 * - act: 可以直接行动
 * - override: 可以覆盖主系统的决策
 */
export type AuthorityLevel = 'observe' | 'suggest' | 'act' | 'override';

/**
 * 安全信任级别
 *
 * - sandboxed: 不信任，输入输出都检查
 * - trusted: 信任输入，检查输出
 * - privileged: 完全信任（系统内部子系统）
 */
export type SecurityLevel = 'sandboxed' | 'trusted' | 'privileged';

/**
 * Boundary 配置
 */
export interface BoundaryConfig {
  visibility: VisibilityLevel;
  authority: AuthorityLevel;
  security: SecurityLevel;
}

// ── Tool 配置 ──

/**
 * 工具配置模式
 *
 * - none: 无工具（默认）
 * - subset: 从主 Agent 工具集中选子集
 * - full: 继承主 Agent 全部工具
 * - custom: 完全自定义工具集
 */
export type ToolMode = 'none' | 'subset' | 'full' | 'custom';

/**
 * Tool 配置
 */
export interface ToolConfig {
  mode: ToolMode;
  /** subset 模式下的工具名列表 */
  names?: string[];
  /** custom 模式下的工具定义 */
  definitions?: RegisteredTool[];
}

// ── Session 配置 ──

/**
 * 会话模式
 *
 * - ephemeral: 每次执行创建新会话（默认）
 * - persistent: 跨执行保持会话
 */
export type SessionMode = 'ephemeral' | 'persistent';

/**
 * 会话作用域
 *
 * - global: 所有 Agent、所有 Session 共享
 * - agent: 同一 Agent 的不同 Session 共享，不同 Agent 隔离
 * - session: 每个主 Session 独立
 */
export type SessionScope = 'global' | 'agent' | 'session';

/**
 * Session 配置
 */
export interface SessionConfig {
  mode: SessionMode;
  scope: SessionScope;
  /** persistent 模式：过期时间（如 '30m'、'24h'） */
  ttl?: string;
}

// ── Lifecycle 配置 ──

/**
 * Lifecycle 配置
 */
export interface LifecycleConfig {
  /** 最大执行时长（毫秒） */
  maxDurationMs?: number;
  /** 最大并发实例数 */
  maxConcurrent?: number;
  /** 最大 token 消耗 */
  maxTokens?: number;
  /** 降级策略 */
  degradeOn?: 'timeout' | 'error' | 'both';
  /** 触发前检查，返回 false 取消执行 */
  onTrigger?: (ctx: SenseContext) => boolean;
  /** 子系统启动时 */
  onStart?: () => void;
  /** 子系统完成时 */
  onComplete?: (result: SubsystemOutput) => void;
  /** 子系统出错时 */
  onError?: (error: Error) => void;
}

// ── SenseContext（触发上下文） ──

/**
 * 触发上下文
 *
 * 传给 condition 评估函数和 lifecycle.onTrigger。
 */
export interface SenseContext {
  /** 当前事件数据 */
  eventData?: unknown;
  /** 指标快照 */
  metrics?: Record<string, number>;
  /** 来源 Agent ID */
  agentId?: string;
  /** 来源 Session ID */
  sessionId?: string;
  /** 主会话生命周期状态（通用） */
  sessionLifecycle?: SessionLifecycleStatus;
  /** 主会话最近交互时间（通用） */
  lastInteractionAt?: number;
  /** 主会话空闲时间（毫秒，通用） */
  idleMs?: number;
  /** 主会话抽取/处理状态（通用） */
  extractionStatus?: ProcessExtractionStatus;
}

// ── SubsystemInput（子系统输入） ──

/**
 * 子系统输入
 *
 * 由 Boundary.visibility 和 Sense.isolation 共同决定内容。
 */
export interface SubsystemInput {
  /** 当前工具调用（仅 intercept 场景） */
  pendingToolCall?: { name: string; arguments: Record<string, unknown> };
  /** 任务摘要 */
  taskSummary?: TaskSummary;
  /** 最近的工具调用记录 */
  recentToolCalls?: Array<{ name: string; arguments: Record<string, unknown>; result?: unknown }>;
  /** 工作目录 */
  workingDirectory?: string;
  /** 会话元数据 */
  sessionMetadata?: { agentId: string; sessionId: string; turnCount: number } & Record<string, unknown>;
  /** Token 使用量 */
  tokenCount?: { used: number; limit: number };
  /** 对话历史（仅 visibility 高于 structured 时） */
  conversationHistory?: Message[];
  /** Agent 事件 */
  agentEvents?: AgentEvent[];
  /** 结构化任务上下文（通用扩展点） */
  payload?: Record<string, unknown>;
}

/**
 * 任务摘要
 */
export interface TaskSummary {
  agentId: string;
  sessionId: string;
  recentTools: string[];
  phase: 'user_request' | 'agent_working';
  pendingAction?: string;
}

// ── SubsystemOutput（子系统输出） ──

/**
 * 子系统输出
 *
 * 包含 Act 和 Signal 两个正交维度。
 */
export interface SubsystemOutput {
  /** Act 结果（如果 act.mode 不为 none） */
  act?: ActResult;
  /** 发出的信号列表 */
  signals: Signal[];
}

/**
 * Act 结果
 */
export interface ActResult {
  /** 执行的行动模式 */
  mode: ActMode;
  /** 执行状态 */
  status: 'success' | 'failed';
  /** 失败原因 */
  error?: string;
  /** block 模式：是否阻止操作 */
  proceed?: boolean;
  /** block 模式：阻止时的结果 */
  result?: unknown;
  /** modify / inject 模式：要注入的消息 */
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** 动作目标（通用语义，如 context / memory-store / knowledge） */
  target?: string;
}

// ── SubsystemRun（审计记录） ──

/**
 * 子系统执行审计记录
 */
export interface SubsystemRun {
  /** 唯一执行 ID */
  id: string;
  /** 子系统标识 */
  subsystemId: string;
  /** 触发原因 */
  trigger: {
    source: string;
    data?: unknown;
    timestamp: number;
  };
  /** 输入快照 */
  input: SubsystemInput;
  /** 思考过程 */
  thinking?: {
    messages?: Message[];
    steps?: string[];
  };
  /** 输出结果 */
  output?: SubsystemOutput;
  /** 发出的信号列表 */
  signals: Signal[];
  /** 执行的直接行动 */
  acts: ActResult[];
  /** 执行时长 */
  durationMs: number;
  /** Token 消耗（LLM 模式） */
  tokenUsage?: { prompt: number; completion: number; total: number };
  /** 执行状态 */
  status: 'success' | 'failed' | 'timeout' | 'degraded';
  /** 错误信息 */
  error?: string;
  /** 时间戳 */
  timestamp: number;
  /** 会话标识 */
  sessionKey: string;
}


// ── Handler 契约（定义文件驱动子系统的标准导出接口） ──

/**
 * 子系统 Handler 契约
 *
 * 定义文件驱动的子系统通过 handler.ts 导出符合此契约的对象。
 * handler 是必选的核心执行函数；contract 和 dependencies 是可选的声明。
 */
export interface SubsystemHandler {
  /** 核心执行函数（必选） */
  handler: (input: SubsystemInput, deps?: InjectedDependencies) => Promise<SubsystemOutput>;
  /** 输入输出契约声明（可选，用于文档和校验） */
  contract?: SubsystemContract;
  /** 依赖声明（可选，与 runtimeInject 配合） */
  dependencies?: string[];
}

/**
 * 子系统输入输出契约（可选声明）
 *
 * 用于类型校验和文档，不强制运行时检查。
 */
export interface SubsystemContract {
  /** 输入契约名称（如 'SessionExtractBundle'） */
  input?: string;
  /** 输出契约名称（如 'ExtractionResult'） */
  output?: string;
}

/**
 * 依赖注入配置
 *
 * 声明子系统 handler 运行时需要的依赖名称。
 * SubsystemRuntime 在执行时从 injectRegistry 中查找并注入。
 */
export interface RuntimeInjectConfig {
  /** 依赖名称列表 */
  requires: string[];
}

/**
 * 生命周期恢复配置
 *
 * 用于断点续提等恢复场景。
 */
export interface LifecycleResumeConfig {
  /** 是否启用恢复扫描 */
  enabled: boolean;
  /** 扫描间隔（毫秒，默认 30000） */
  scanIntervalMs?: number;
  /** 最大重试次数（默认 5） */
  maxRetries?: number;
  /** 重试退避基础间隔（毫秒，默认 60000） */
  baseRetryMs?: number;
  /** 最大重试间隔（毫秒，默认 600000） */
  maxRetryMs?: number;
}

/**
 * 观测性配置
 *
 * 用于统一子系统的事件前缀和指标命名。
 */
export interface ObservabilityConfig {
  /** 事件前缀（如 'memory.extractor'） */
  eventPrefix: string;
}

/**
 * 运行时注入依赖映射
 *
 * 由 SubsystemRuntime 管理，handler 执行时通过 deps 参数传入。
 */
export type InjectedDependencies = Record<string, unknown>;

// ── SubsystemSpec（完整规格） ──

/**
 * 自主子系统完整规格
 *
 * 五维模型：Sense + Think + Act + Signal + Boundary
 */
export interface SubsystemSpec {
  // ── 身份 ──
  id: string;
  name: string;
  description: string;

  // ── 五维配置 ──
  sense: SenseConfig;
  think: ThinkConfig;
  act: ActConfig;
  signal: SignalConfig;
  boundary: BoundaryConfig;

  // ── 附加配置 ──
  tools: ToolConfig;
  session: SessionConfig;
  lifecycle?: LifecycleConfig;
  /** 该子系统可能产生的事件类型（静态循环检测使用；未设置时从 sense.filter.emits 兜底） */
  emits?: string[];

  // ── 运行时扩展 ──
  /** 依赖注入配置（可选） */
  runtimeInject?: RuntimeInjectConfig;
  /** 生命周期恢复配置（可选） */
  resume?: LifecycleResumeConfig;
  /** 观测性配置（可选） */
  observability?: ObservabilityConfig;

  // ── 元数据 ──
  /** 子系统特定配置（从 config.yaml 的 metadata 字段读取，由 handler 通过 __subsystem_config__ 注入依赖消费） */
  metadata?: Record<string, unknown>;

  /** 版本号 */
  version?: string;
  /** 来源（内置 / 用户 / 项目 / npm） */
  source?: 'builtin' | 'user' | 'project' | 'npm';
  /** 来源路径 */
  sourcePath?: string;
}

// ── Model Level（模型分级） ──

/**
 * 模型分级配置
 */
export interface ModelLevelConfig {
  primary: string;
  fallback?: string[];
}

/**
 * models.level 配置表
 */
export type ModelLevelMap = Record<string, ModelLevelConfig>;

// 主会话生命周期态（子系统通用感知）
export type SessionLifecycleStatus = 'active' | 'recent' | 'extracted' | 'archived';
// 通用抽取/处理状态（不特指 memory）
export type ProcessExtractionStatus = 'pending' | 'soft' | 'completed' | 'skipped' | 'error';

// ── AgentContext（主 Agent 上下文，供子系统引用） ──

/**
 * 主 Agent 上下文
 *
 * 由外部注入，子系统通过 Boundary.visibility 决定能看到什么。
 */
export interface AgentContext {
  messages: Message[];
  runConfig: {
    systemPrompt?: string;
    agentId?: string;
    sessionId?: string;
    model?: string;
    cwd?: string;
  };
  pendingToolCall?: { name: string; arguments: Record<string, unknown> };
  events: EventBus;
  recentToolCalls?: Array<{ name: string; arguments: Record<string, unknown>; result?: unknown }>;
  tokenCount?: { used: number; limit: number };
  agentEvents?: AgentEvent[];

  // 主会话生命周期态（通用，由 Runner/SessionLifecycleBridge 注入）
  sessionLifecycle?: SessionLifecycleStatus;
  lastInteractionAt?: number;
  idleMs?: number;
  extractionStatus?: ProcessExtractionStatus;
}
