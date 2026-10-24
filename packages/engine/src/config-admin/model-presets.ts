/**
 * provider 预设清单 —「生成器 + 表单默认值」（arch/config-hot-reload.md §5.1）
 *
 * 核心原则：预设只在**创建时**把表单预填成 `ModelProviderConfig` 片段，
 * 确认后展开写入 octopi.json，与手写配置完全同构。预设不是运行时配置源，
 * 不引入第二真相源——运行时不感知本模块。
 *
 * 模型参数（contextWindow / maxTokens）为**参考值**，以厂商文档为准；
 * 表单允许逐字段覆盖，错了不致命（只影响路由与截断预算）。
 *
 * @module
 */

/** 预设中的单个模型条目（参数为参考值，可改） */
export interface ModelPresetModel {
  /** 模型 id（请求时的 model 字段） */
  id: string;
  /** 展示名 */
  name: string;
  /** 是否推理模型 */
  reasoning?: boolean;
  /** 输入模态 */
  input?: Array<'text' | 'image' | 'audio' | 'video'>;
  /** 上下文窗口（参考值） */
  contextWindow?: number;
  /** 单次最大输出 tokens（参考值） */
  maxTokens?: number;
}

/** provider 预设条目 */
export interface ProviderPreset {
  /** 预设 id（= 创建后的默认 provider 名） */
  id: string;
  /** 展示名 */
  label: string;
  /** API 协议 */
  api: 'openai-completions' | 'anthropic-messages';
  /** 默认 baseUrl */
  baseUrl: string;
  /** 建议的 apiKey 环境变量名（表单提示用，非绑定） */
  apiKeyEnvHint: string;
  /** 厂商文档链接 */
  docsUrl?: string;
  /** 预置模型清单（参考值） */
  models: ModelPresetModel[];
  /** 自定义模板（空预设）：只给骨架，模型清单由用户填写 */
  custom?: boolean;
}

/** 内置预设清单（随发行版维护；新增厂商直接扩表） */
export const BUILTIN_MODEL_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnvHint: 'OPENAI_API_KEY',
    docsUrl: 'https://platform.openai.com/docs/models',
    models: [
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 256000,
        maxTokens: 32768,
      },
      {
        id: 'gpt-5-mini',
        name: 'GPT-5 Mini',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnvHint: 'ANTHROPIC_API_KEY',
    docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models',
    models: [
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 200000,
        maxTokens: 16000,
      },
      {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 200000,
        maxTokens: 32000,
      },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnvHint: 'DEEPSEEK_API_KEY',
    docsUrl: 'https://api-docs.deepseek.com/',
    models: [
      {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        input: ['text'],
        contextWindow: 131072,
        maxTokens: 8192,
      },
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek Reasoner',
        reasoning: true,
        input: ['text'],
        contextWindow: 131072,
        maxTokens: 8192,
      },
    ],
  },
  {
    id: 'qwen',
    label: '通义千问（百炼 DashScope）',
    api: 'openai-completions',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnvHint: 'DASHSCOPE_API_KEY',
    docsUrl: 'https://help.aliyun.com/zh/model-studio',
    models: [
      {
        id: 'qwen-max',
        name: 'Qwen Max',
        input: ['text'],
        contextWindow: 32768,
        maxTokens: 8192,
      },
      {
        id: 'qwen-plus',
        name: 'Qwen Plus',
        input: ['text'],
        contextWindow: 131072,
        maxTokens: 8192,
      },
      {
        id: 'qwen-turbo',
        name: 'Qwen Turbo',
        input: ['text'],
        contextWindow: 131072,
        maxTokens: 8192,
      },
    ],
  },
  {
    id: 'kimi',
    label: 'Kimi（月之暗面）',
    api: 'openai-completions',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnvHint: 'MOONSHOT_API_KEY',
    docsUrl: 'https://platform.moonshot.cn/docs',
    models: [
      {
        id: 'kimi-latest',
        name: 'Kimi Latest',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 131072,
        maxTokens: 16384,
      },
    ],
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    api: 'openai-completions',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnvHint: 'ZHIPU_API_KEY',
    docsUrl: 'https://open.bigmodel.cn/dev',
    models: [
      {
        id: 'glm-4.6',
        name: 'GLM-4.6',
        reasoning: true,
        input: ['text'],
        contextWindow: 200000,
        maxTokens: 16384,
      },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini（OpenAI 兼容端点）',
    api: 'openai-completions',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnvHint: 'GEMINI_API_KEY',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    models: [
      {
        id: 'gemini-3-pro',
        name: 'Gemini 3 Pro',
        reasoning: true,
        input: ['text', 'image', 'audio', 'video'],
        contextWindow: 1000000,
        maxTokens: 65536,
      },
      {
        id: 'gemini-3-flash',
        name: 'Gemini 3 Flash',
        input: ['text', 'image', 'audio', 'video'],
        contextWindow: 1000000,
        maxTokens: 65536,
      },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    api: 'openai-completions',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyEnvHint: '',
    docsUrl: 'https://ollama.com/library',
    models: [
      { id: 'qwen3', name: 'Qwen3（本地）', input: ['text'], contextWindow: 32768, maxTokens: 8192 },
      { id: 'llama3.3', name: 'Llama 3.3（本地）', input: ['text'], contextWindow: 32768, maxTokens: 8192 },
    ],
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    api: 'openai-completions',
    baseUrl: '',
    apiKeyEnvHint: 'API_KEY',
    models: [],
    custom: true,
  },
];

/**
 * 按 id 取预设
 *
 * @param id - 预设 id
 * @returns 预设条目；未知 id 返回 undefined
 */
export function getProviderPreset(id: string): ProviderPreset | undefined {
  return BUILTIN_MODEL_PRESETS.find((p) => p.id === id);
}

/**
 * 列出全部内置预设
 *
 * @returns 预设清单（只读）
 */
export function listProviderPresets(): readonly ProviderPreset[] {
  return BUILTIN_MODEL_PRESETS;
}

/**
 * 预设展开为 `ModelProviderConfig` 表单默认值（生成器语义）
 *
 * - apiKey 缺省给 `${ENV_HINT}` 引用形态（写回保留占位符，见 arch/config-hot-reload.md §0）；
 *   无 env 提示（如 ollama）时为 `''`（不发鉴权）。
 * - `custom` 预设不带默认 models（表单强制用户填写）。
 * - `overrides` 为用户已编辑的表单值，逐字段覆盖预设默认值。
 *
 * @param presetId - 预设 id
 * @param overrides - 用户表单覆盖值（可选）
 * @returns 可写入 octopi.json 的 provider 配置片段
 * @throws 未知 presetId 时抛错（fail-loud，不做静默空对象）
 */
export function expandProviderPreset(
  presetId: string,
  overrides?: Partial<import('../config.js').ModelProviderConfig>,
): import('../config.js').ModelProviderConfig {
  const preset = getProviderPreset(presetId);
  if (!preset) {
    throw new Error(`unknown model preset: ${presetId}`);
  }
  const apiKeyDefault = preset.apiKeyEnvHint ? `\${${preset.apiKeyEnvHint}}` : '';
  return {
    baseUrl: preset.baseUrl,
    apiKey: apiKeyDefault,
    api: preset.api,
    models: preset.custom ? [] : preset.models.map((m) => ({ ...m })),
    ...overrides,
  };
}
