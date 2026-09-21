/**
 * 配置系统
 *
 * 支持从 JSON 配置文件加载 Gateway 配置。
 * 配置文件查找：-c 指定路径 → ./octopi.json → ~/.octopi/octopi.json
 * 仓库内不要维护 octopi.json 实例（已 gitignore）；本地统一用 ~/.octopi/octopi.json。
 *
 * v0.2.0: 扩展配置结构以支持新架构（AgentBuilder + SessionAwareRunner）。
 * 保持向后兼容——旧字段仍然有效，新字段可选。
 *
 * 配置示例：
 * ```json
 * {
 *   "agents": [{
 *     "id": "assistant",
 *     "home": "./agents/assistant",
 *     "workspace": "./workspace/assistant",
 *     "model": { "provider": "openai", "model": "gpt-5.5" },
 *     "tools": { "allow": ["*"] }
 *   }],
 *   "providers": [{
 *     "type": "openai",
 *     "name": "openai",
 *     "apiKey": "${OPENAI_API_KEY}",
 *     "models": ["gpt-5.5"]
 *   }],
 *   "plugins": { "loadPaths": ["./plugins"] },
 *   "security": { "preset": "production" },

 *   "channels": [{ "type": "http", "port": 3000 }],
 *   "session": {
 *     "dmScope": "per-peer"
 *   }
 * }
 * ```
 *
 * 注意：`session.store` / `dataDir` 已废弃——Gateway 固定使用 `agents/<id>/sessions/`。
 * doctor 检测 CFG010；`--fix config` 将 store 迁入 `_legacy.session.store`。
 */

import type { ToolPolicy, ModelInfo } from './core/types.js';
import type { AgentDefinition, ModelConfig as _ModelConfig } from './harness/types/agent-definition.js';
import type { GatewayConfig } from './integration/types/gateway-config.js';
import type { ModelProvider } from './core/interfaces/model-provider.js';
import type { SessionStore } from './core/interfaces/session-store.js';
import type { SessionData } from './harness/session-types.js';
import type { SecurityGuardConfig } from './core/security-guard.js';
import { validateConfigOrThrow } from './config-schema.js';
import { applyLegacyBudget, detectConfigMigrations } from './config-migrations.js';
import { getOctopiHome } from './init.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_CONTEXT_WINDOW } from './core/types/model-info.js';

/** 产品默认上下文窗口（与 core/types/model-info 一致，未声明能力时按此预算） */
export { DEFAULT_CONTEXT_WINDOW };

// ── Agent 配置 ──

/**
 * Agent 配置
 *
 * persona 字段支持两种形式：
 * - string: persona 目录路径（文件式 persona）
 * - object: 内联 persona 定义（向后兼容 v0.1.x）
 */
export interface AgentConfig {
  /** Agent 唯一标识 */
  id: string;
  /** Agent home 目录：persona、skills、sessions、extract 的根目录（memory/wisdom 走 AgentDatabase SQLite） */
  home?: string;
  /** 沙箱工作目录：agent 工具操作的 cwd，默认为 home 下的 workspace 子目录 */
  workspace?: string;
  /**
   * Persona 配置（向后兼容：string 形式等价于 home）
   * - string: persona 目录路径（已废弃，请使用 home）
   * - object: 内联 persona 定义
   */
  persona?: string | {
    name?: string;
    description?: string;
    systemPrompt: string;
  };
  /**
   * 模型配置
   *
   * 两种形式：
   * - string: 引用 models[] 中的 id，或 "provider/model" 格式
   * - object: 内联模型配置（向后兼容）
   */
  model: string | _ModelConfig;
  /** 工具策略 */
  tools?: ToolPolicy;
  /** Skill 目录 */
  skillDirectory?: string;
  /** 启用的 Skill 列表 */
  skills?: string[];
  /** Channel 绑定 */
  channelBindings?: Record<string, string>;
  /** Session ACL 天花板（E6 L1） */
  maxSessionRights?: import('./harness/session-acl/types.js').SessionRights;
}

// ── Web Search 配置 ──

/** 单个 web search provider slot */
export interface WebSearchProviderSlot {
  /** 实现类型 */
  api: 'duckduckgo' | 'tavily' | 'brave' | 'serper' | 'mimo';
  /** API Key（支持 ${ENV_VAR}；duckduckgo 可省略） */
  apiKey?: string;
  /** 覆盖默认 baseUrl */
  baseUrl?: string;
  /** 覆盖默认超时（毫秒） */
  timeoutMs?: number;
  /** MiMo 专用：模型 ID（默认 mimo-v2.5-pro） */
  model?: string;
  /** MiMo 专用：搜索关键词数上限（max_keyword，默认 3） */
  maxKeyword?: number;
  /** MiMo 专用：是否强制搜索（force_search，默认 true） */
  forceSearch?: boolean;
  /** MiMo 专用：用户位置（approximate） */
  userLocation?: { country?: string; region?: string; city?: string };
}

/** web_search 工具顶层配置 */
export interface WebSearchToolConfig {
  /** 主 provider（providers 的 key）；未指定时取 providers 第一个 */
  provider?: string;
  /** 失败降级链（provider key 列表） */
  fallbacks?: string[];
  /** 默认返回条数（默认 5） */
  defaultLimit?: number;
  /** 全局超时（毫秒，默认 15000） */
  timeoutMs?: number;
  /** provider 映射 */
  providers?: Record<string, WebSearchProviderSlot>;
}

/**
 * Session 配置（合并了旧的 store + session 节点）
 */
export interface SessionConfig {
  /** DM 作用域: main / per-peer / per-channel-peer */
  dmScope?: 'main' | 'per-peer' | 'per-channel-peer';
}

// ── Plugin 配置 ──

/**
 * Plugin 配置
 */
export interface PluginConfig {
  /** Plugin 目录扫描路径 */
  loadPaths?: string[];
  /** 单个 plugin 的配置（plugin id → config） */
  configs?: Record<string, Record<string, unknown>>;
}



// ── Store 配置 ──




// ── Channel 配置 ──

/**
 * Channel 配置
 */
export interface ChannelConfig {
  /** 类型（http） */
  type: string;
  /** 端口（HTTP channel 用） */
  port?: number;
  /** 路径（HTTP channel 用） */
  path?: string;
  /** API Key（HTTP channel 认证） */
  apiKey?: string;
  /** 允许的 CORS 源 */
  corsOrigins?: string[];
}



// ── Budget Policy 配置（octopi.json 形状）──

/**
 * BudgetPolicyJsonConfig — octopi.json 中的 budgetPolicy 字段
 *
 * 见 arch/budget-redesign.md：
 * - 默认 **无** nominal token hard（Σ nominalTotalTokens 不作为出厂熔断）
 * - P0：仅 wall-clock 安全阀 + 可显式 iteration/tool 上限
 * - P2：控制梯配置（wrap-up 策略）
 * - P3：扩展 usd / uncached 等 opt-in 单位；键名仅 budgetPolicy（无 budget）
 */
export interface BudgetPolicyJsonConfig {
  /** 安全阀：最大运行时间毫秒（默认 6h） */
  maxWallClockMs?: number;
  /** 最大迭代次数。仅显式设置时硬停 */
  maxIterations?: number;
  /** 最大工具调用次数。仅显式设置时硬停 */
  maxToolCalls?: number;
  // ── P2 控制梯配置 ──
  /** Policy 触达时的行为：'stop' 立即停止 | 'wrap_up_then_stop' 先总结再停止（默认） */
  onPolicyHit?: 'stop' | 'wrap_up_then_stop';
  /** wrap-up 窗口的轮次数（默认 3） */
  wrapUpTurns?: number;
  /** context 轴 wrap-up 触发阈值比例（默认 0.85） */
  contextWrapUpRatio?: number;
  // ── P3 Policy 单位配置 ──
  /** 预算单位配置（仅显式配置才启用 hard） */
  units?: {
    /** 最大花费（币种由 pricing 决定） */
    maxCost?: number;
    /** 最大 uncached input tokens */
    maxUncachedInputTokens?: number;
    /** 最大 output tokens */
    maxOutputTokens?: number;
    /** 最大 LLM 调用次数 */
    maxLlmCalls?: number;
  };
  /** 模型定价（用于 cost 估算，币种自定义） */
  pricing?: Record<string, {
    /** 每 1M input tokens 价格 */
    inputPer1M: number;
    /** 每 1M cached input tokens 价格（可选） */
    cachedInputPer1M?: number;
    /** 每 1M output tokens 价格 */
    outputPer1M: number;
  }>;
  /** advisory 告警配置 */
  advisory?: {
    /** 告警单位 */
    unit: 'wall_clock_ms' | 'cost' | 'uncached_input_tokens' | 'output_tokens' | 'llm_calls';
    /** 告警阈值 */
    threshold: number;
  };
}

// ── RunGuard 配置（octopi.json 形状）──

/**
 * RunGuardJsonConfig — octopi.json 中的 runGuard 字段形状
 *
 * 过程监督，与 budget 组合：Budget 管资源，RunGuard 管行为是否跑飞。
 * 通过检查点机制实现：每 N 轮迭代审查一次，决定继续/恢复/终止。
 *
 * 注意：与 harness/run-guard 的 `RunGuardConfig`（实现配置）同结构但不同名，
 * 避免调用方 import 错模块。
 */
export interface RunGuardJsonConfig {
  /** 是否启用（默认 true） */
  enabled?: boolean;
  /** 基础检查间隔（迭代数，默认 15） */
  checkpointInterval?: number;
  /** 最小检查间隔（默认 5） */
  minCheckpointInterval?: number;
  /** 最大检查间隔（默认 50） */
  maxCheckpointInterval?: number;
  /** 启用 LLM 审查（默认 true） */
  enableLLMReview?: boolean;
  /** LLM 审查频率（每 N 个检查点审查一次，默认 3） */
  llmReviewInterval?: number;
  /**
   * 审查用的模型
   *
   * 支持两种格式：
   * - 模型名（如 "qwen-turbo"）：使用主 provider
   * - 完整名（如 "ollama/qwen3:4b"）：使用指定 provider
   */
  llmModel?: string;
  /** 硬上限：最大迭代数（默认 1000） */
  hardLimit?: number;
  /** 硬上限：最大 wall-clock 时间（毫秒，默认 10 小时） */
  hardWallClockMs?: number;
}

// ── Agent Runtime 配置（octopi.json 形状）──

/**
 * AgentRuntimeJsonConfig — long-lived 激活宿主（arch/agent-runtime.md）
 *
 * 消息路径始终经 Runtime dispatch。
 * Schedule/Escalate 等 Source：**配置块存在才挂载**；不要则不写该块（无 enabled 总开关）。
 */
export interface AgentRuntimeJsonConfig {
  /** 默认合批窗口 ms（建议 300–500） */
  coalesceWindowMs?: number;
  /** 合批缓冲条目上限（防事件风暴） */
  coalesceBufferLimit?: number;
  /** 期望最大并发 Run（仅观测/告警；硬闸归 SessionGate） */
  expectedMaxConcurrentRuns?: number;
  /** 定时触发；每条 job 绑定 agentId */
  schedule?: Array<{
    agentId: string;
    sessionId?: string;
    /** 与 cron 二选一 */
    intervalMs?: number;
    /** 简化 cron：分 时 日 月 周；非法表达式跳过 */
    cron?: string;
    /** 注入内容（system note） */
    content: string;
    coalesceKey?: string;
    runOnStart?: boolean;
  }>;
  /**
   * 子系统 escalate → 唤醒主 Agent。
   * 需与 Subsystem 使用同一 EventBus（Gateway 已接 gatewayBus）。
   */
  escalate?: {
    /** 事件缺 agentId 时的默认目标 */
    defaultAgentId?: string;
    /** 默认同时订 subsystem.signal.escalate 与 subsystem.escalate */
    eventType?: string | string[];
  };
  /** 订阅 runtime.agent_signal（多 Agent 通知）；默认随 escalate 一起挂 */
  agentSignal?: boolean;
}



// ── 上下文引擎配置 ──

/**
 * 上下文引擎配置
 *
 * 控制上下文管理行为：消息选择、压缩策略、预算分配。
 */
export interface ContextEngineConfig {
  /** 引擎类型（默认 'default'） */
  type?: 'default' | 'custom';
  /** 头部保护消息数（默认 3） */
  protectFirstN?: number;
  /** 尾部保护消息数（默认 20） */
  protectLastN?: number;
  /** 触发压缩的阈值比例（默认 0.5） */
  compactThreshold?: number;
  /**
   * 主动摘要阈值：消息 token / messagesBudget 超过该比例时，
   * 在硬溢出前先 LLM 摘要（默认 0.6；0 = 关闭）
   */
  proactiveCompactRatio?: number;
  /**
   * 主动 LLM 摘要冷却 ms（默认 30000；0 = 不冷却）。
   * 冷却期内优先缓存重建，降低单 turn 双摘要。
   */
  proactiveCooldownMs?: number;
  /** 输出预留比例（默认 0.20） */
  outputRatio?: number;
  /** 输出预留最小值（默认 2000） */
  minOutputReserve?: number;
  /** 输出预留最大值（默认 8000） */
  maxOutputReserve?: number;
  /** 是否启用 LLM 摘要（默认 true） */
  enableLLMSummary?: boolean;
  /** 摘要模型（可选，使用主模型） */
  summaryModel?: string;
}

/**
 * 公用能力 summary 配置（harness/capabilities）
 */
export interface SummaryCapabilityConfig {
  /** 模型档名；缺省解析链使用 summary */
  modelLevel?: string;
  /** 显式 provider/model */
  model?: string;
  defaultInputBudgetTokens?: number;
  safetyMarginTokens?: number;
  oversizedStrategy?: 'map_reduce' | 'window' | 'truncate_fallback' | 'fail';
  gate?: {
    minTokens?: number;
    minBytes?: number;
    respectPolicyBudget?: boolean;
  };
  /** policy id → 整策略对象（全量替换） */
  policies?: Record<string, unknown>;
  tools?: {
    maxReturnChars?: number;
    http_request?: Record<string, unknown>;
    file_read?: Record<string, unknown>;
  } & Record<string, unknown>;
  cache?: {
    enabled?: boolean;
    backend?: 'memory' | 'file';
    ttlMs?: number;
    maxEntries?: number;
    dir?: string;
  };
}

/**
 * 公用能力 compact 缺省配置
 */
export interface CompactCapabilityConfig {
  defaultProtectHead?: number;
  defaultProtectTail?: number;
  defaultTargetTokens?: number;
  defaultMode?: 'structure_only' | 'summary_only' | 'head_tail_only' | 'auto';
}

/**
 * system prompt 层装配器配置（七层 ContextAssembler）
 *
 * 与 contextEngine 分工：本配置管 **system 总预算与可选单层硬顶**；
 * contextEngine 管 **消息窗口压缩**。
 *
 * 预算语义：默认只控 system 总量 + priority 竞争；
 * `layerShares` 仅对显式配置的层生效（硬顶 = contentBudget × share）。
 */
export interface ContextAssemblerConfig {
  /** system 预算占 contextWindow 比例（默认 0.22）；窗口未知时不生效 */
  systemBudgetRatio?: number;
  /** 显式 system 预算 token（窗口未知时仍可用，优先于 ratio） */
  systemBudgetTokens?: number;
  /** 显式压缩目标 token；窗口未知时用于结构压缩/assemble 预算 */
  compactTargetTokens?: number;
  /**
   * 单层硬顶：层 id → contentBudget 比例 [0,1]。
   * 默认不配置 = 无单层配额。配置了的层超出会先被截断到硬顶。
   */
  layerShares?: Partial<Record<'wisdom' | 'persona' | 'skill' | 'knowledge' | 'cognition' | 'memory' | 'runtime', number>>;
  /**
   * 是否在 AssembleManifest.layers[].preview 写入层正文截断（默认 true）
   * 开启后 Web「上下文」面板可展示层预览；正文不进入模型输入。
   */
  includeLayerPreview?: boolean;
  /** preview 最大字符数（默认 400） */
  layerPreviewChars?: number;
  /**
   * 是否在 AssembleManifest.layers[].content 写入层正文全文（默认 true）
   * 点选层时 Web 展示具体内容。
   */
  includeLayerContent?: boolean;
}

/** 全局运行宪法配置 */
export interface ConstitutionConfig {
  mode: 'product' | 'custom' | 'off';
  /** custom 模式必填 */
  path?: string | null;
}



// ── 集中模型配置 ──

/**
 * 集中模型定义
 *
 * 在 models[] 中集中定义，agent 通过 id 或 "provider/model" 引用。
 * 避免多 agent 使用同一模型时重复配置。
 */
export interface ModelDefinition {
  /** 模型唯一标识（可选，默认为 "provider/model"） */
  id?: string;
  /** Provider 名称（引用 providers[].name） */
  provider: string;
  /** 模型名称 */
  model: string;
  /** 温度 */
  temperature?: number;
  /** 最大 token 数 */
  maxTokens?: number;
  /** 上下文窗口大小 */
  contextWindow?: number;
  /** 失败时的备选模型（支持 string 引用或内联配置） */
  fallbackModels?: (string | ModelDefinition)[];
}



/**
 * 全局默认值
 */
export interface Defaults {
  /**
   * 默认上下文窗口（仅当用户显式配置时生效）。
   * 未配置时模型 contextWindow 保持未知，不自动填 200k。
   */
  contextWindow?: number;
}





// ── 模型能力声明 ──

/** 模型输入类型 */
export type ModelInputType = 'text' | 'image' | 'audio' | 'video';

/** 单个模型能力定义（models.providers[].models[] 中的元素） */
export interface ModelCapability {
  /** 模型 ID（provider 内唯一，如 "mimo-v2.5-pro"） */
  id: string;
  /** 模型名称（实际发送给 API 的名称，默认等于 id） */
  name?: string;
  /** 是否支持推理/思考模式 */
  reasoning?: boolean;
  /** 支持的输入类型 */
  input?: ModelInputType[];
  /** 上下文窗口大小 */
  contextWindow?: number;
  /** 最大输出 token 数 */
  maxTokens?: number;
}



/** Provider 定义（新格式，嵌入在 models.providers 中） */
export interface ModelProviderConfig {
  /** API 基础 URL */
  baseUrl: string;
  /** API Key（支持 ${ENV_VAR} 语法） */
  apiKey: string;
  /** API 协议类型 */
  api: 'openai-completions' | 'anthropic-messages';
  /** 此 provider 下的模型列表 */
  models: ModelCapability[];
  /** 请求超时（秒） */
  timeoutSeconds?: number;
}



/** 模型级别定义（primary + fallback 降级链） */
export interface LevelConfig {
  /** 主模型，格式: provider/model */
  primary: string;
  /** 降级模型列表（按优先级排列，格式: provider/model） */
  fallback?: string[];
}

/** 模型级别映射表（级别名 → 级别定义） */
export type LevelMap = Record<string, LevelConfig>;

/** Embedding API 协议 */
export type EmbeddingApiType = 'openai' | 'ollama' | 'http' | 'custom';

/** 向量检索引擎 */
export type VectorEngineChoice = 'auto' | 'js' | 'sqlite-vec';

/** HTTP 请求/响应字段映射（通用远程 embedding） */
export interface EmbeddingHttpMappingConfig {
  inputField?: string;
  modelField?: string;
  embeddingsPath?: string;
  itemEmbeddingPath?: string;
  extraBody?: Record<string, unknown>;
}

/**
 * Embedding 模型配置（models.embedding）
 *
 * 放在 models 节点下：memory / knowledge / plugin 等可共用同一 embedding。
 * 未配置时检索退化为关键词路径。
 *
 * 鉴权：apiKey 可省略或 ""（不发 Authorization），适合内网/无鉴权远程。
 * provider 仅在 apiKey 未写出时继承其凭据。
 */
export interface EmbeddingModelConfig {
  /** 显式关闭；缺省视为开启（仅当节点存在时才启用向量） */
  enabled?: boolean;
  /** 嵌入 API 协议；缺省按 provider/baseUrl 推断（openai 兼容） */
  type?: EmbeddingApiType;
  /** 引用 models.providers 的 key，继承 baseUrl；apiKey 仅在未写出时继承 */
  provider?: string;
  /** 模型名 */
  model: string;
  baseUrl?: string;
  /** API Key；"" 或省略且未继承 = 不发送鉴权头 */
  apiKey?: string;
  /** Key 所在 Header；默认 Authorization。"" = 不发送 */
  apiKeyHeader?: string;
  /** Key 前缀；Authorization 默认 "Bearer " */
  apiKeyPrefix?: string;
  /** 请求 path；openai 默认 /embeddings，ollama 默认 /api/embeddings */
  path?: string;
  /** 额外请求头 */
  headers?: Record<string, string>;
  /** 通用 HTTP 字段映射 */
  request?: EmbeddingHttpMappingConfig;
  /** 是否支持批量（仅单条接口时设 false） */
  supportsBatch?: boolean;
  /** 请求超时 ms */
  timeoutMs?: number;
  /** 向量维度 */
  dimensions?: number;
  /** 向量检索引擎；auto=优先 sqlite-vec，失败退回 JS */
  vectorEngine?: VectorEngineChoice;
  /** sqlite-vec 扩展路径（可选） */
  sqliteVecExtensionPath?: string;
}

/** 新格式的 models 配置 */
export interface ModelsConfig {
  /** 合并模式：merge=与 builtin 合并，replace=完全替代 */
  mode?: 'merge' | 'replace';
  /** Provider 映射（key = provider 名称） */
  providers: Record<string, ModelProviderConfig>;
  /** 模型级别映射（子系统通过级别名引用具体模型） */
  level?: LevelMap;
  /** Embedding 模型配置（可选；多处可复用） */
  embedding?: EmbeddingModelConfig;
}



// ── 完整配置 ──

/** 自主子系统配置（框架级：搜索路径与审计；子系统自身参数写在各自 config.yaml） */
export interface SubsystemsConfig {
  /** 审计日志目录（默认 ~/.octopi/audit） */
  auditDir?: string;
  /** 允许注册：id / packageId / `memory.steward.*` 前缀 */
  allowlist?: string[];
  /** 禁止注册（deny 优先） */
  denylist?: string[];
}

/**
 * 完整配置文件结构（v0.3.0）
 */
export interface HarnessConfig {
  /** 自主子系统配置 */
  subsystems?: SubsystemsConfig;

  /** Agent 列表 */
  agents: AgentConfig[];
  /** 模型配置（集中定义 provider + model） */
  models: ModelsConfig;
  /** 全局默认值 */
  defaults?: Defaults;
  /** Plugin 配置 */
  plugins?: PluginConfig;
  /** Run 安全阀 / 策略（budgetPolicy；无默认 token hard） */
  budgetPolicy?: BudgetPolicyJsonConfig;
  /** 过程监督配置（行为监督；与 budget 组合） */
  runGuard?: RunGuardJsonConfig;
  /** 激活宿主（long-lived；Schedule/Escalate 等） */
  agentRuntime?: AgentRuntimeJsonConfig;
  /** 上下文引擎配置 */
  contextEngine?: ContextEngineConfig;
  /** 公用能力 summary（harness/capabilities） */
  summary?: SummaryCapabilityConfig;
  /** 公用能力 compact 缺省 */
  compact?: CompactCapabilityConfig;
  /** system prompt 七层装配器配置 */
  contextAssembler?: ContextAssemblerConfig;
  /** context 域扩展：全局宪法等 */
  context?: {
    constitution?: ConstitutionConfig;
    contextAssembler?: ContextAssemblerConfig;
  };
  /** 全局宪法（顶层简写，等价 context.constitution） */
  constitution?: ConstitutionConfig;
  /** Memory 写入/置信度策略 */
  memory?: {
    profile?: 'personal_assistant' | 'embedded_interactive' | 'embedded_headless';
    confidence?: {
      injectMinScore?: number;
      channelPriors?: Partial<Record<'user_directive' | 'decision' | 'fail_fix' | 'model_inference' | 'admin', number>>;
    };
    gates?: {
      maxLength?: Partial<Record<'fact' | 'method' | 'norm', number>>;
    };
  };
  /** 安全策略 */
  security?: {
    /** 预设名称 */
    preset?: 'development' | 'testing' | 'production' | 'maximum';
    /** 注入检测灵敏度 */
    injectionSensitivity?: 'low' | 'medium' | 'high';
  };
  /** Channel 列表 */
  channels?: ChannelConfig[];
  /** Session 配置 */
  session?: SessionConfig;
  /**
   * 工具效应隔离策略（宪法 I5）
   *
   * - `none`（默认）：多 Session 共享 agent.workspace
   * - `session-subdir`：cwd → `<workspace>/<sessionId>/`
   * - `session-lock`：共享路径；同 sessionId 由 Runner 锁串行（不路径隔离）
   */
  toolIsolation?: 'none' | 'session-subdir' | 'session-lock';
  /**
   * Session ACL 角色目录（E6）
   *
   * 缺省使用内置五角色；可覆盖/新增。handoff 默认仅宿主。
   */
  sessionAcl?: import('./harness/session-acl/types.js').SessionAclConfig;
  /** 并发控制配置 */
  concurrency?: {
    /** 多 Key Provider 负载均衡池 */
    providerPool?: {
      /** 池中的 slot 列表 */
      slots: Array<{
        /** 引用 providers[].name */
        provider: string;
        /** 权重（默认 1） */
        weight?: number;
        /** slot 级限流配置（覆盖全局默认） */
        rateLimit?: {
          requestsPerMinute: number;
          burstCapacity?: number;
          maxWaitMs?: number;
        };
      }>;
      /** 路由配置 */
      routing?: {
        /** 路由策略（默认 sticky） */
        strategy?: 'sticky' | 'round-robin' | 'least-loaded';
        /** 粘滞超时（毫秒，默认 1800000） */
        stickyTtlMs?: number;
        /** 故障转移模式（默认 auto） */
        failover?: 'auto' | 'manual';
      };
      /** 全局默认限流配置 */
      rateLimit?: {
        requestsPerMinute: number;
        burstCapacity?: number;
        maxWaitMs?: number;
      };
    };
    /** Session 并发控制 */
    sessionGate?: {
      /** 最大并发 session 数（默认 50） */
      maxConcurrent?: number;
      /** 排队超时（毫秒，默认 30000） */
      waitTimeoutMs?: number;
    };
  };
  /** 网络搜索配置（web_search 工具） */
  webSearch?: WebSearchToolConfig;
  /** Web UI 运行配置 */
  web?: {
    /** Web UI 源码目录（含 package.json）；未设置时按 CLI 内置顺序探测 */
    dir?: string;
  };
  /** 产品 Observer 通道（开发/测试 Run 现场；生产可 summary/off） */
  observer?: import('./harness/observer/types.js').ObserverConfig;
  /** 可观测性配置 */
  observability?: {
    /** 日志级别: 0=FATAL, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG, 5=TRACE */
    level?: number;
    /** 控制台输出级别（null = 不输出到控制台） */
    consoleLevel?: number | null;
    /** Trace 文件输出目录（null = 不输出到文件） */
    traceDir?: string | null;
    /** 是否记录流式 delta（数据量大，默认关闭） */
    captureStreamDeltas?: boolean;
    /** 是否记录完整模型请求 */
    captureModelRequest?: boolean;
  };
}



// ── 加载函数 ──

/**
 * 从配置文件加载配置
 *
 * @param configPath - 配置文件路径；未指定时按 cwd → OCTOPI_HOME 查找
 * @returns 解析后的配置
 */

// ModelConfig 定义见 harness/types/agent-definition.ts（已在此文件顶部 import）

/**
 * 解析 Agent 的模型配置
 *
 * 支持三种方式（按优先级）：
 * 1. 内联对象：{ provider, model, ... }（向后兼容）
 * 2. 引用 models[] 中的 id
 * 3. "provider/model" 格式字符串
 *
 * @param modelRef - agent.model 字段（string 或内联对象）
 * @param models - 集中定义的模型列表（可选）
 * @param defaults - 全局默认值（可选）
 * @returns 解析后的 ModelConfig
 */

/**
 * 判断 models 字段是否为新格式（ModelsConfig 对象）
 */

/**
 * 从 ModelsConfig 提取所有模型的扁平列表（供 resolveModelConfig 查找）
 */
export function flattenModels(config: ModelsConfig): NormalizedModelInfo[] {
  const result: NormalizedModelInfo[] = [];
  for (const [providerName, pc] of Object.entries(config.providers)) {
    for (const mc of pc.models) {
      result.push({
        id: `${providerName}/${mc.id}`,
        provider: providerName,
        model: mc.name ?? mc.id,
        contextWindow: mc.contextWindow,
        maxTokens: mc.maxTokens,
      });
    }
  }
  return result;
}



export function resolveModelConfig(
  modelRef: string | _ModelConfig,
  models: NormalizedModelInfo[],
  defaults?: Defaults,
): _ModelConfig {
  // 仅当用户配置了 defaults.contextWindow 时才作为兜底；不自动猜 200k
  const defaultContextWindow = defaults?.contextWindow;

  // 内联对象（向后兼容）— 未写的 contextWindow 保持 undefined（未知）
  if (typeof modelRef === 'object') {
    const resolved = { ...modelRef };
    if (resolved.contextWindow == null && defaultContextWindow != null) {
      resolved.contextWindow = defaultContextWindow;
    }
    resolved.fallbackModels = resolveFallbackModels(resolved.fallbackModels as any, models, defaults, 1);
    return resolved;
  }

  // string 引用：按 id 查找（格式为 "provider/modelId"）
  const ref = modelRef;
  const found = models.find(m => m.id === ref);

  if (found) {
    return {
      provider: found.provider,
      model: found.model,
      contextWindow: found.contextWindow ?? defaultContextWindow,
      fallbackModels: resolveFallbackModels(undefined, models, defaults),
    };
  }

  // 兜底：尝试解析 "provider/model" 格式
  const slashIdx = ref.indexOf('/');
  if (slashIdx > 0) {
    return {
      provider: ref.slice(0, slashIdx),
      model: ref.slice(slashIdx + 1),
      contextWindow: defaultContextWindow,
    };
  }

  throw new Error(
    `Cannot resolve model "${ref}". ` +
    `Available models: ${(models ?? []).map(m => m.id ?? `${m.provider}/${m.model}`).join(', ') || '(none)'}`
  );
}



/**
 * 解析回退模型列表
 *
 * 将 (string | ModelConfig)[] 统一解析为 ModelConfig[]。
 * string 引用按 resolveModelConfig 同样的逻辑查找。
 */
const MAX_FALLBACK_DEPTH = 5;

function resolveFallbackModels(
  fallbacks: Array<string | _ModelConfig> | undefined,
  models: NormalizedModelInfo[],
  defaults?: Defaults,
  depth: number = 0,
): _ModelConfig[] | undefined {
  if (depth >= MAX_FALLBACK_DEPTH) {
    console.warn('[config] Fallback model nesting exceeds maximum depth, truncating');
    return undefined;
  }
  if (!fallbacks || fallbacks.length === 0) return undefined;
  return fallbacks.map(fb => {
    if (typeof fb === 'string') {
      const found = models.find(m => m.id === fb);
      if (found) {
        return {
          provider: found.provider,
          model: found.model,
          contextWindow: found.contextWindow ?? defaults?.contextWindow,
        };
      }
      const slashIdx = fb.indexOf('/');
      if (slashIdx > 0) {
        return {
          provider: fb.slice(0, slashIdx),
          model: fb.slice(slashIdx + 1),
          contextWindow: defaults?.contextWindow,
        };
      }
      throw new Error(`Cannot resolve fallback model "${fb}"`);
    }
    const m = fb as _ModelConfig;
    return {
      provider: m.provider,
      model: m.model,
      temperature: m.temperature,
      maxTokens: m.maxTokens,
      contextWindow: m.contextWindow ?? defaults?.contextWindow,
      fallbackModels: resolveFallbackModels(m.fallbackModels, models, defaults, depth + 1),
    };
  });
}



export function loadConfig(configPath?: string): NormalizedHarnessConfig {
  // 配置文件查找优先级：
  // 1. 明确指定的路径
  // 2. 当前目录 ./octopi.json
  // 3. OCTOPI_HOME/octopi.json（默认 ~/.octopi/octopi.json，与 getOctopiHome 一致）
  let filePath: string;
  if (configPath) {
    filePath = resolve(configPath);
  } else if (existsSync(resolve('./octopi.json'))) {
    filePath = resolve('./octopi.json');
  } else {
    const homeConfig = resolve(getOctopiHome(), 'octopi.json');
    if (existsSync(homeConfig)) {
      filePath = homeConfig;
    } else {
      throw new Error(
        `Config file not found. Searched:\n` +
        `  1. ${resolve('./octopi.json')}\n` +
        `  2. ${homeConfig}\n\n` +
        `Run 'octopi init' to create a new configuration.`
      );
    }
  }

  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  console.log(`[config] Loading config from ${filePath}`);

  const fileContent = readFileSync(filePath, 'utf-8');

  // 支持 ${ENV_VAR} 和 ${ENV_VAR:-default} 环境变量替换
  const expanded = fileContent.replace(/\$\{(\w+)(?::-(.*?))?\}/g, (_, key, defaultVal) => {
    const val = process.env[key];
    if (val !== undefined) return val;
    if (defaultVal !== undefined) return defaultVal;
    // 未设置且无默认值：返回空字符串（apiKey 等字段会在后续校验中报错）
    return '';
  });

  const raw = JSON.parse(expanded);

  // 旧字段静默失效会很难排查：显式告警（写回落盘见 octopi doctor --fix）
  if (raw && typeof raw === 'object') {
    for (const finding of detectConfigMigrations(raw)) {
      const hint = finding.hint ? ` ${finding.hint}` : '';
      console.warn(`[config] ${finding.message}.${hint}`);
    }
    // 运行时内存迁移：legacy budget → budgetPolicy（丢弃 spend/soft）
    applyLegacyBudget(raw as Record<string, unknown>);
    if (raw && typeof raw === 'object' && 'budget' in (raw as object)) {
      delete (raw as Record<string, unknown>).budget;
    }
  }

  // Zod schema 校验（结构化错误信息）
  const config = validateConfigOrThrow(raw) as unknown as NormalizedHarnessConfig;


  config.flatModels = flattenModels(config.models as ModelsConfig);

  // 提取 models.level 到顶层 levelMap（方便下游直接使用）
  const modelsConfig = config.models as ModelsConfig;
  if (modelsConfig.level) {
    config.levelMap = modelsConfig.level;
  }

  return config;
}



/**
 * 将 HarnessConfig 转换为旧版 GatewayConfig（向后兼容）
 */
/** 内部使用的规范化配置（loadConfig 输出） */
export interface NormalizedHarnessConfig extends HarnessConfig {
  /** 从 models.providers 提取的扁平模型列表 */
  flatModels: NormalizedModelInfo[];
  /** 从 models.level 解析的级别映射（已规范化） */
  levelMap?: LevelMap;
}



/** 扁平化的模型信息（供 resolveModelConfig 查找） */
export interface NormalizedModelInfo {
  id: string;
  provider: string;
  model: string;
  contextWindow?: number;
  maxTokens?: number;
}



export function toGatewayConfig(config: NormalizedHarnessConfig): GatewayConfig {
  // 解析 agent model 配置：string 引用 → ModelConfig 对象
  const resolvedAgents: AgentDefinition[] = config.agents.map(ac => ({
    id: ac.id,
    home: ac.home ?? (typeof ac.persona === 'string' ? ac.persona : ''),
    workspace: ac.workspace,
    persona: typeof ac.persona === 'object'
      ? { name: ac.persona.name ?? ac.id, description: ac.persona.description ?? '', systemPrompt: ac.persona.systemPrompt }
      : { name: ac.id, description: '', systemPrompt: '' },
    tools: ac.tools ? { allow: ac.tools.allow ?? [], deny: ac.tools.deny ?? [] } : { allow: [], deny: [] },
    model: resolveModelConfig(ac.model, config.flatModels, config.defaults),
    skillDirectory: ac.skillDirectory,
    skills: ac.skills,
    channelBindings: ac.channelBindings,
    maxSessionRights: ac.maxSessionRights,
  }));

  const gatewayConfig: GatewayConfig = {
    agents: resolvedAgents,
    session: config.session ? { dmScope: config.session.dmScope } : undefined,
    toolIsolation: config.toolIsolation,
    sessionAcl: config.sessionAcl,
    budgetPolicy: config.budgetPolicy,
    contextAssembler: config.context?.contextAssembler ?? config.contextAssembler,
    context: config.context,
    constitution: config.context?.constitution ?? config.constitution,
    memory: config.memory,
    observer: config.observer,
    embedding: config.models?.embedding,
    modelProviders: config.models?.providers,
    levels: config.levelMap ?? (config.models as ModelsConfig | undefined)?.level,
  };

  if (config.agentRuntime) {
    gatewayConfig.agentRuntime = {
      coalesceWindowMs: config.agentRuntime.coalesceWindowMs,
      coalesceBufferLimit: config.agentRuntime.coalesceBufferLimit,
      expectedMaxConcurrentRuns: config.agentRuntime.expectedMaxConcurrentRuns,
    };
  }

  // 传递可观测性配置
  if (config.observability?.traceDir !== null && config.observability?.traceDir !== undefined) {
    const levelMap: Record<number, string> = { 1: 'ERROR', 2: 'WARN', 3: 'INFO', 4: 'DEBUG', 5: 'TRACE' };
    gatewayConfig.trace = {
      outputDir: config.observability.traceDir,
      level: levelMap[config.observability.level ?? 3] as any ?? 'INFO',
    };
  }

  return gatewayConfig;
}



// ── Provider 工厂 ──

/**
 * 从 ModelProviderConfig 创建 ModelProvider 实例
 *
 * 根据 type 字段自动选择 OpenAI 或 Anthropic provider。
 * 使用动态 import 以支持 ESM。
 */
export async function createProviderFromConfig(name: string, pc: ModelProviderConfig): Promise<ModelProvider> {
  const apiType = pc.api === 'anthropic-messages' ? 'anthropic' : 'openai';
  const models = pc.models.map(m => ({ name: m.name ?? m.id, contextWindow: m.contextWindow, maxOutputTokens: m.maxTokens }));
  const defaultModel = pc.models[0]?.name ?? pc.models[0]?.id;

  if (apiType === 'anthropic') {
    const { AnthropicProvider } = await import('./integration/providers/anthropic.js');
    return new AnthropicProvider({ name, apiKey: pc.apiKey, baseUrl: pc.baseUrl, models, defaultModel, timeoutMs: pc.timeoutSeconds ? pc.timeoutSeconds * 1000 : undefined });
  }

  const { OpenAIProvider } = await import('./integration/providers/openai.js');
  return new OpenAIProvider({ name, apiKey: pc.apiKey, baseUrl: pc.baseUrl, models, defaultModel, timeoutMs: pc.timeoutSeconds ? pc.timeoutSeconds * 1000 : undefined });
}




