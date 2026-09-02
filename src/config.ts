/**
 * 配置系统
 *
 * 支持从 JSON 配置文件加载 Gateway 配置。
 * 配置文件默认路径：./octopi.json
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
 *     "dmScope": "per-peer",
 *     "store": { "type": "jsonl", "dataDir": "./data/sessions" }
 *   }
 * }
 * ```
 */

import type { AgentDefinition, ToolPolicy, ModelInfo } from './core/types.js';
import type { GatewayConfig } from './integration/types/gateway-config.js';
import type { ModelProvider } from './core/interfaces/model-provider.js';
import type { SessionStore } from './core/interfaces/session-store.js';
import type { SessionData } from './harness/session-types.js';
import type { IterationBudgetConfig } from './harness/budget/budget.js';
import type { SecurityGuardConfig } from './core/security-guard.js';
import type { TaskSupervisorConfig } from './harness/task-system/supervisor/task-supervisor.js';
import { validateConfigOrThrow } from './config-schema.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

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
  /** Agent home 目录：persona、memory、wisdom、skills、sessions 的根目录 */
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
}

/**
 * Session 配置（合并了旧的 store + session 节点）
 */
export interface SessionConfig {
  /** DM 作用域: main / per-peer / per-channel-peer */
  dmScope?: 'main' | 'per-peer' | 'per-channel-peer';
  /** Session 存储配置 */
  store?: StoreConfig;
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

/**
 * Session 存储配置
 */
export interface StoreConfig {
  /** 存储类型 */
  type: 'memory' | 'jsonl' | 'sqlite';
  /** 数据目录（jsonl 类型必填） */
  dataDir?: string;
  /** 数据库文件路径（sqlite 类型可选，默认 :memory:） */
  dbPath?: string;
}



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



// ── Supervisor 配置 ──

/**
 * TaskSupervisor 配置
 *
 * 智能监督系统，替代 IterationBudget 的硬限制。
 * 通过检查点机制实现：每 N 轮迭代审查一次，决定继续/恢复/终止。
 */
export interface SupervisorConfig {
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
  /** 默认上下文窗口大小（当模型和 provider 都未指定时使用，默认 200000） */
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



/** 新格式的 models 配置 */
export interface ModelsConfig {
  /** 合并模式：merge=与 builtin 合并，replace=完全替代 */
  mode?: 'merge' | 'replace';
  /** Provider 映射（key = provider 名称） */
  providers: Record<string, ModelProviderConfig>;
}



// ── 完整配置 ──

/**
 * 完整配置文件结构（v0.3.0）
 */
export interface HarnessConfig {
  /** Agent 列表 */
  agents: AgentConfig[];
  /** 模型配置（集中定义 provider + model） */
  models: ModelsConfig;
  /** 全局默认值 */
  defaults?: Defaults;
  /** Plugin 配置 */
  plugins?: PluginConfig;
  /** 迭代预算（安全兜底，由 TaskSupervisor 接管主要控制） */
  budget?: Partial<IterationBudgetConfig>;
  /** 任务监督器配置（智能监督，替代硬限制） */
  supervisor?: SupervisorConfig;
  /** 上下文引擎配置 */
  contextEngine?: ContextEngineConfig;
  /** 安全策略 */
  security?: {
    /** 预设名称 */
    preset?: 'development' | 'testing' | 'production' | 'maximum';
    /** 注入检测灵敏度 */
    injectionSensitivity?: 'low' | 'medium' | 'high';
  };
  /** 分布式智能体 */
  distributedIntelligence?: {
    /** 安全守卫 */
    safetyGuard?: {
      /** 启用安全守卫（默认 false） */
      enabled: boolean;
      /** 安全智能体使用的模型（不填用主 Agent 模型，格式：provider/model） */
      model?: string;
      /** 最大执行时长（毫秒，默认 15000） */
      maxDurationMs?: number;
    };
  };
  /** Channel 列表 */
  channels?: ChannelConfig[];
  /** Session 配置 */
  session?: SessionConfig;
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
 * @param configPath - 配置文件路径（默认 ./octopi.json）
 * @returns 解析后的配置
 */

import type { ModelConfig as _ModelConfig } from './core/types/agent-definition.js';

const DEFAULT_CONTEXT_WINDOW = 200_000;

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
  const defaultContextWindow = defaults?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

  // 内联对象（向后兼容）
  if (typeof modelRef === 'object') {
    const resolved = { ...modelRef, contextWindow: modelRef.contextWindow ?? defaultContextWindow };
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
      // 查找 models[] 中的定义
      const found = models.find(m => m.id === fb);
      if (found) {
        return {
          provider: found.provider,
          model: found.model,
          contextWindow: found.contextWindow ?? defaults?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        };
      }
      // 解析 "provider/model" 格式
      const slashIdx = fb.indexOf('/');
      if (slashIdx > 0) {
        return {
          provider: fb.slice(0, slashIdx),
          model: fb.slice(slashIdx + 1),
          contextWindow: defaults?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        };
      }
      throw new Error(`Cannot resolve fallback model "${fb}"`);
    }
    // 内联 ModelConfig 或 ModelDefinition（只取 ModelConfig 字段）
    const m = fb as _ModelConfig;
    return {
      provider: m.provider,
      model: m.model,
      temperature: m.temperature,
      maxTokens: m.maxTokens,
      contextWindow: m.contextWindow ?? defaults?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      fallbackModels: resolveFallbackModels(m.fallbackModels, models, defaults, depth + 1),
    };
  });
}



export function loadConfig(configPath?: string): NormalizedHarnessConfig {
  // 配置文件查找优先级：
  // 1. 明确指定的路径
  // 2. 当前目录 ./octopi.json
  // 3. OCTOPI_HOME/octopi.json（默认 ~/octopi/octopi.json）
  let filePath: string;
  if (configPath) {
    filePath = resolve(configPath);
  } else if (existsSync(resolve('./octopi.json'))) {
    filePath = resolve('./octopi.json');
  } else {
    // 尝试 OCTOPI_HOME
    const homeDir = process.env.OCTOPI_HOME ?? resolve(homedir(), 'octopi');
    const homeConfig = resolve(homeDir, 'octopi.json');
    if (existsSync(homeConfig)) {
      filePath = homeConfig;
    } else {
      throw new Error(
        `Config file not found. Searched:\n` +
        `  1. ${resolve(configPath ?? './octopi.json')}\n` +
        `  2. ${homeConfig}\n\n` +
        `Run 'octopi init' to create a new configuration.`
      );
    }
  }

  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

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

  // Zod schema 校验（结构化错误信息）
  const config = validateConfigOrThrow(raw) as unknown as NormalizedHarnessConfig;

  // ── 向后兼容：迁移旧的顶层 store 到 session.store ──
  if (raw.store && !config.session?.store) {
    console.warn('[config] "store" 顶层配置已废弃，请迁移到 "session.store"。自动迁移中...');
    const mutable = config as NormalizedHarnessConfig & { session?: { store?: StoreConfig } };
    if (!mutable.session) mutable.session = {};
    mutable.session.store = raw.store as StoreConfig;
  }

  config.flatModels = flattenModels(config.models as ModelsConfig);
  return config;
}



/**
 * 将 HarnessConfig 转换为旧版 GatewayConfig（向后兼容）
 */
/** 内部使用的规范化配置（loadConfig 输出） */
export interface NormalizedHarnessConfig extends HarnessConfig {
  /** 从 models.providers 提取的扁平模型列表 */
  flatModels: NormalizedModelInfo[];
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
  const resolvedAgents: import('./core/types/agent-definition.js').AgentDefinition[] = config.agents.map(ac => ({
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
  }));

  const gatewayConfig: GatewayConfig = {
    agents: resolvedAgents,
    session: config.session ? { dmScope: config.session.dmScope } : undefined,
    budget: config.budget,
  };

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



/**
 * 从 StoreConfig 创建 SessionStore 实例
 * 使用动态 import 以支持 ESM。
 */
export async function createStoreFromConfig(sc: StoreConfig): Promise<SessionStore<SessionData>> {
  if (sc.type === 'memory') {
    const { InMemorySessionStore } = await import('./integration/storage/memory.js');
    return new InMemorySessionStore();
  }

  if (sc.type === 'jsonl') {
    if (!sc.dataDir) {
      throw new Error('Store type "jsonl" requires dataDir');
    }
    const { JsonlSessionStore } = await import('./integration/storage/jsonl.js');
    // 传入 legacyDataDir 以兼容旧的 dataDir/{agentId}/ 目录结构
    return new JsonlSessionStore(() => '', sc.dataDir);
  }

  if (sc.type === 'sqlite') {
    const { SqliteSessionStore } = await import('./integration/storage/sqlite.js');
    return SqliteSessionStore.create({ dbPath: sc.dbPath });
  }

  throw new Error(`Unknown store type: "${sc.type}"`);
}
