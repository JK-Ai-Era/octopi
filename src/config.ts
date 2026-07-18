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
 *     "workspace": "./workspace",
 *     "persona": "./personas/assistant",
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
 *   "store": { "type": "jsonl", "dataDir": "./data/sessions" },
 *   "channels": [{ "type": "http", "port": 3000 }],
 *   "session": { "dmScope": "per-peer" }
 * }
 * ```
 */

import type { AgentDefinition, GatewayConfig, ToolPolicy, ModelInfo } from './core/types.js';
import type { ModelProvider } from './core/interfaces/model-provider.js';
import type { SessionStore } from './core/interfaces/session-store.js';
import type { IterationBudgetConfig } from './core/budget.js';
import type { SecurityGuardConfig } from './core/security-guard.js';
import type { TaskSupervisorConfig } from './harness/supervisor/task-supervisor.js';
import { validateConfigOrThrow } from './config-schema.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// ── Provider 配置 ──

/**
 * Provider 配置
 */
export interface ProviderConfig {
  /** 协议类型：openai=OpenAI Chat Completions, anthropic=Anthropic Messages */
  type: 'openai' | 'anthropic';
  /** 名称（agent.model.provider 引用此名称） */
  name: string;
  /** API Key（支持 ${ENV_VAR} 语法） */
  apiKey?: string;
  /** Base URL */
  baseUrl?: string;
  /**
   * 支持的模型
   *
   * 两种形式：
   * - string: 只有模型名称
   * - ModelInfo: 名称 + 能力声明（contextWindow, maxOutputTokens）
   */
  models?: (string | ModelInfo)[];
  /** 默认模型 */
  defaultModel?: string;
  /** 请求超时（毫秒，默认 60000） */
  timeoutMs?: number;
}

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
  /** 工作目录 */
  workspace?: string;
  /**
   * Persona 配置
   * - string: persona 目录路径（如 "./personas/assistant"）
   * - object: 内联定义（向后兼容）
   */
  persona?: string | {
    name?: string;
    description?: string;
    systemPrompt: string;
  };
  /** 模型配置 */
  model: {
    /** Provider 名称（引用 providers[].name） */
    provider: string;
    /** 模型名称 */
    model: string;
    /** 温度 */
    temperature?: number;
    /** 最大 token 数 */
    maxTokens?: number;
    /** 失败时的备选模型 */
    fallbackModels?: string[];
  };
  /** 工具策略 */
  tools?: ToolPolicy;
  /** Skill 目录 */
  skillDirectory?: string;
  /** 启用的 Skill 列表 */
  skills?: string[];
  /** Channel 绑定 */
  channelBindings?: Record<string, string>;
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

// ── 完整配置 ──

/**
 * 完整配置文件结构（v0.2.0）
 */
export interface HarnessConfig {
  /** Agent 列表 */
  agents: AgentConfig[];
  /** LLM Provider 列表 */
  providers?: ProviderConfig[];
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
  /** Session 存储 */
  store?: StoreConfig;
  /** Channel 列表 */
  channels?: ChannelConfig[];
  /** Session 配置 */
  session?: GatewayConfig['session'];
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
export function loadConfig(configPath?: string): HarnessConfig {
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
  const config = validateConfigOrThrow(raw) as HarnessConfig;

  return config;
}

/**
 * 将 HarnessConfig 转换为旧版 GatewayConfig（向后兼容）
 */
export function toGatewayConfig(config: HarnessConfig): GatewayConfig {
  const gatewayConfig: GatewayConfig = {
    agents: config.agents as unknown as AgentDefinition[],
    session: config.session,
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
 * 从 ProviderConfig 创建 ModelProvider 实例
 *
 * 根据 type 字段自动选择 OpenAI 或 Anthropic provider。
 * 使用动态 import 以支持 ESM。
 */
export async function createProviderFromConfig(pc: ProviderConfig): Promise<ModelProvider> {
  const apiKey = pc.apiKey;
  if (!apiKey) {
    throw new Error(`Provider "${pc.name}" must have an apiKey`);
  }

  if (pc.type === 'openai') {
    const { OpenAIProvider } = await import('./integration/providers/openai.js');
    return new OpenAIProvider({
      name: pc.name,
      apiKey,
      baseUrl: pc.baseUrl,
      models: pc.models,
      defaultModel: pc.defaultModel,
      timeoutMs: pc.timeoutMs,
    });
  }

  if (pc.type === 'anthropic') {
    const { AnthropicProvider } = await import('./integration/providers/anthropic.js');
    return new AnthropicProvider({
      name: pc.name,
      apiKey,
      baseUrl: pc.baseUrl,
      models: pc.models,
      defaultModel: pc.defaultModel,
      timeoutMs: pc.timeoutMs,
    });
  }

  throw new Error(`Unknown provider type: "${pc.type}"`);
}

/**
 * 从 StoreConfig 创建 SessionStore 实例
 * 使用动态 import 以支持 ESM。
 */
export async function createStoreFromConfig(sc: StoreConfig): Promise<SessionStore> {
  if (sc.type === 'memory') {
    const { InMemorySessionStore } = await import('./integration/storage/memory.js');
    return new InMemorySessionStore();
  }

  if (sc.type === 'jsonl') {
    if (!sc.dataDir) {
      throw new Error('Store type "jsonl" requires dataDir');
    }
    const { JsonlSessionStore } = await import('./integration/storage/jsonl.js');
    return new JsonlSessionStore(sc.dataDir);
  }

  if (sc.type === 'sqlite') {
    const { SqliteSessionStore } = await import('./integration/storage/sqlite.js');
    return SqliteSessionStore.create({ dbPath: sc.dbPath });
  }

  throw new Error(`Unknown store type: "${sc.type}"`);
}
