/**
 * Plugin Manifest — 对齐 OpenClaw 的 openclaw.plugin.json 格式
 *
 * Manifest 是 plugin 的声明式元数据，框架在不执行 plugin 代码的情况下
 * 就能读取和验证。这是 plugin 系统的基础。
 *
 * 参考: https://docs.openclaw.ai/plugins/manifest
 */

/**
 * JSON Schema 基础类型（简化版）
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
}

/**
 * Plugin Manifest
 *
 * 对齐 OpenClaw 的 openclaw.plugin.json 格式。
 * 所有字段都是声明式的，不需要执行 plugin 代码。
 */
export interface PluginManifest {
  /** Plugin 唯一 ID（必填） */
  id: string;

  /** 人类可读名称 */
  name?: string;

  /** 简短描述 */
  description?: string;

  /** Plugin 版本 */
  version?: string;

  /** 配置 JSON Schema（必填，即使为空对象也要声明） */
  configSchema: JsonSchema;

  /** 此 plugin 拥有的 provider IDs */
  providers?: string[];

  /** 此 plugin 拥有的 channel IDs */
  channels?: string[];

  /** 此 plugin 拥有的 CLI backend IDs */
  cliBackends?: string[];

  /** 此 plugin 拥有的能力声明 */
  contracts?: PluginContracts;

  /** 激活规划元数据（控制何时加载 plugin） */
  activation?: ActivationConfig;

  /** Setup/onboarding 元数据 */
  setup?: SetupConfig;

  /** Skill 目录列表（相对于 plugin root） */
  skills?: string[];

  /** 依赖的其他 plugin IDs */
  requiresPlugins?: string[];

  /** 是否默认启用 */
  enabledByDefault?: boolean;

  /** 仅在指定平台默认启用 */
  enabledByDefaultOnPlatforms?: string[];

  /** 旧版 plugin IDs（兼容迁移） */
  legacyPluginIds?: string[];

  /** 配置了指定 provider 时自动启用 */
  autoEnableWhenConfiguredProviders?: string[];

  /** exclusive slot 类型（如 "memory"、"context-engine"） */
  kind?: 'memory' | 'context-engine';

  /** 模型前缀匹配（自动识别 provider） */
  modelSupport?: {
    modelPrefixes?: string[];
    modelPatterns?: string[];
  };

  /** Provider 目录元数据 */
  modelCatalog?: Record<string, unknown>;

  /** UI 提示信息 */
  uiHints?: Record<string, UiHint>;

  /** Tool 可用性元数据 */
  toolMetadata?: Record<string, ToolAvailabilityMetadata>;

  /** Channel 配置元数据 */
  channelConfigs?: Record<string, ChannelConfigMetadata>;
}

/**
 * 能力声明（contracts）
 *
 * 声明此 plugin 拥有的各种能力。
 * 用于不加载 plugin 代码就能知道谁拥有什么能力。
 */
export interface PluginContracts {
  /** Agent tool 名称列表 */
  tools?: string[];

  /** Embedding provider IDs */
  embeddingProviders?: string[];

  /** Speech provider IDs */
  speechProviders?: string[];

  /** Realtime transcription provider IDs */
  realtimeTranscriptionProviders?: string[];

  /** Realtime voice provider IDs */
  realtimeVoiceProviders?: string[];

  /** Media understanding provider IDs */
  mediaUnderstandingProviders?: string[];

  /** Image generation provider IDs */
  imageGenerationProviders?: string[];

  /** Video generation provider IDs */
  videoGenerationProviders?: string[];

  /** Music generation provider IDs */
  musicGenerationProviders?: string[];

  /** Web fetch provider IDs */
  webFetchProviders?: string[];

  /** Web search provider IDs */
  webSearchProviders?: string[];

  /** External auth provider IDs */
  externalAuthProviders?: string[];

  /** Gateway method dispatch 授权 */
  gatewayMethodDispatch?: string[];
}

/**
 * 激活配置
 *
 * 控制 plugin 何时被加载。这是 planner 元数据，
 * 不是生命周期钩子，不替代 register()。
 */
export interface ActivationConfig {
  /** Gateway 启动时加载 */
  onStartup?: boolean;

  /** 匹配指定 provider 时加载 */
  onProviders?: string[];

  /** 匹配指定 command 时加载 */
  onCommands?: string[];

  /** 匹配指定 channel 时加载 */
  onChannels?: string[];

  /** 匹配指定 route 时加载 */
  onRoutes?: string[];

  /** 匹配指定 config path 时加载 */
  onConfigPaths?: string[];

  /** 匹配指定能力类型时加载 */
  onCapabilities?: Array<'provider' | 'channel' | 'tool' | 'hook'>;
}

/**
 * Setup 配置
 *
 * 用于 onboarding 和初始设置流程。
 */
export interface SetupConfig {
  /** Provider setup 描述 */
  providers?: SetupProviderDescriptor[];

  /** CLI backend IDs */
  cliBackends?: string[];

  /** 是否需要运行时执行（false = 只用描述符） */
  requiresRuntime?: boolean;
}

/**
 * Provider setup 描述符
 */
export interface SetupProviderDescriptor {
  /** Provider ID */
  id: string;

  /** 支持的认证方式 */
  authMethods?: string[];

  /** 环境变量列表 */
  envVars?: string[];

  /** 认证证据（本地文件/环境变量检查） */
  authEvidence?: AuthEvidence[];
}

/**
 * 认证证据
 */
export interface AuthEvidence {
  /** 证据类型 */
  type: 'local-file-with-env';

  /** 包含凭证文件路径的环境变量 */
  fileEnvVar?: string;

  /** 备选文件路径 */
  fallbackPaths?: string[];

  /** 必须存在的环境变量（至少一个） */
  requiresAnyEnv?: string[];

  /** 必须存在的环境变量（全部） */
  requiresAllEnv?: string[];

  /** 非密钥标记 */
  credentialMarker: string;

  /** 来源标签 */
  source?: string;
}

/**
 * UI 提示
 */
export interface UiHint {
  /** 字段标签 */
  label?: string;

  /** 帮助文本 */
  help?: string;

  /** 占位符 */
  placeholder?: string;

  /** 是否敏感（密码等） */
  sensitive?: boolean;

  /** 是否为高级选项 */
  advanced?: boolean;

  /** 标签 */
  tags?: string[];
}

/**
 * Tool 可用性元数据
 *
 * 用于在不加载 plugin 代码的情况下判断 tool 是否可用。
 */
export interface ToolAvailabilityMetadata {
  /** 认证信号 */
  authSignals?: Array<{
    provider: string;
    providerBaseUrl?: {
      provider: string;
      defaultBaseUrl?: string;
      allowedBaseUrls?: string[];
    };
  }>;

  /** 配置信号 */
  configSignals?: Array<{
    rootPath: string;
    overlayPath?: string;
    required?: string[];
    requiredAny?: string[];
    mode?: {
      path?: string;
      default?: string;
      allowed?: string[];
      disallowed?: string[];
    };
  }>;
}

/**
 * Channel 配置元数据
 */
export interface ChannelConfigMetadata {
  /** Channel config JSON Schema */
  schema?: JsonSchema;

  /** UI 提示 */
  uiHints?: Record<string, UiHint>;

  /** Channel 标签 */
  label?: string;

  /** Channel 描述 */
  description?: string;
}

/**
 * 验证 manifest 格式
 *
 * @param raw - 原始 JSON 对象
 * @returns 验证后的 manifest
 * @throws 验证失败时抛出错误
 */
export function validateManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Plugin manifest must be a JSON object');
  }

  const m = raw as Record<string, unknown>;

  if (!m.id || typeof m.id !== 'string') {
    throw new Error('Plugin manifest must have a string "id" field');
  }

  if (!m.configSchema || typeof m.configSchema !== 'object') {
    throw new Error(`Plugin "${m.id}" manifest must have a "configSchema" object`);
  }

  return m as unknown as PluginManifest;
}

/**
 * 从 JSON 文件解析 manifest
 *
 * @param json - JSON 字符串
 * @returns 验证后的 manifest
 */
export function parseManifest(json: string): PluginManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Plugin manifest is not valid JSON');
  }
  return validateManifest(raw);
}
