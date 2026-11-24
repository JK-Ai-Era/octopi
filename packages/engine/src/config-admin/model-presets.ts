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
 * 取值口径（2026-11-20 按各厂商官方文档逐项核对）：
 * - 只写官方文档明写的数字；「1M / 128K」这类简称按 1048576 / 131072 换算。
 * - 官方只给「输入 X / 输出 Y」两条独立上限时，允许折成总窗口 `X + Y` 写入
 *   `contextWindow`（分配器的不变量是 input+output ≤ 窗口），但必须在条目注释里标明折算依据。
 * - 官方未公布逐模型输出上限的厂商（xAI / Mistral / 硅基流动 / Ollama 等），
 *   `maxTokens` 留空 —— 不填保守估算值，避免用一个假上限收紧截断预算。
 * - `maxTokens` 必须小于 `contextWindow`：分配器按「input+output ≤ contextWindow」硬预留输出，
 *   输出上限等于整窗时（如 Spark 的低窗口档、豆包 turbo）同样留空，否则输入预算归零。
 * - `models` 至少一条（config-schema 要求 `.min(1)`）；`custom` 是唯一空清单模板。
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

/**
 * 接入方式（同一 provider 的不同端点/协议/计费网关）
 *
 * 只在**额外**接入方式上出现：provider 顶层的 `api` / `baseUrl` / `apiKeyEnvHint` / `models`
 * 即「标准 API（按量计费）」，是本模块对该 provider 的单一大真相源；本结构只描述差异项，
 * 未给出的字段（如 models）回落顶层值。这样新增一条 plan 接入方式不会复制一份模型清单。
 */
export interface ProviderAccessMode {
  /** 接入方式 id（同一 provider 内唯一，如 `standard` / `token-plan` / `coding-plan`） */
  id: string;
  /** 展示名 */
  label: string;
  /** 展示名本地化（缺省回落 label） */
  labels?: import('./i18n.js').LocalizedText;
  /** API 协议（该接入方式下实际可用的协议） */
  api: 'openai-completions' | 'anthropic-messages';
  /** baseUrl（逐字，含路径） */
  baseUrl: string;
  /** 建议的 apiKey 环境变量名（缺省回落顶层） */
  apiKeyEnvHint?: string;
  /** 「去哪拿 key」提示（缺省回落顶层 keyHints） */
  keyHints?: import('./i18n.js').LocalizedText;
  /** 该接入方式的模型清单（缺省回落顶层 models；列出即为**替换**，不是增量） */
  models?: ModelPresetModel[];
  /** 计费/限制说明（如「订阅制，按席位计费」「仅对已订阅用户开放」） */
  notes?: import('./i18n.js').LocalizedText;
  /** 官方文档链接（缺省回落顶层 docsUrl） */
  docsUrl?: string;
}

/** provider 预设条目 */
export interface ProviderPreset {
  /** 预设 id（= 创建后的默认 provider 名） */
  id: string;
  /** 展示名 */
  label: string;
  /** 展示名本地化（缺省回落 label；品牌名常两语同形） */
  labels?: import('./i18n.js').LocalizedText;
  /** API 协议 */
  api: 'openai-completions' | 'anthropic-messages';
  /** 默认 baseUrl */
  baseUrl: string;
  /** 建议的 apiKey 环境变量名（表单提示用，非绑定） */
  apiKeyEnvHint: string;
  /** 「去哪拿 key」提示（向导用；缺省回落 docsUrl） */
  keyHints?: import('./i18n.js').LocalizedText;
  /** 厂商文档链接 */
  docsUrl?: string;
  /** 预置模型清单（参考值） */
  models: ModelPresetModel[];
  /**
   * 额外接入方式（如订阅制的 coding-plan / token-plan 网关）。
   *
   * 顶层 `api`/`baseUrl`/`apiKeyEnvHint`/`models` 即「标准 API」，不需要在这里重复；
   * 只有确实提供**另一套端点或协议**的厂商才填。UI 按 provider 展示「接入方式」下拉，
   * 选中某一条即加载该条差异值（未给字段回落顶层）。缺省/空数组 = 只有标准 API。
   */
  modes?: ProviderAccessMode[];
  /** 自定义模板（空预设）：只给骨架，模型清单由用户填写 */
  custom?: boolean;
}

/** 内置预设清单（随发行版维护；新增厂商直接扩表） */
export const BUILTIN_MODEL_PRESETS: readonly ProviderPreset[] = [
  // ── 国际 ────────────────────────────────────────────────────────────────
  {
    id: 'openai',
    label: 'OpenAI',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnvHint: 'OPENAI_API_KEY',
    keyHints: {
      zh: '在 platform.openai.com → API keys 创建',
      en: 'Create one at platform.openai.com → API keys',
    },
    docsUrl: 'https://developers.openai.com/api/docs/models',
    models: [
      {
        id: 'gpt-6.2-astra',
        name: 'GPT-6.2 Astra',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1050000,
        maxTokens: 128000,
      },
      {
        id: 'gpt-6.2-sol',
        name: 'GPT-6.2 Sol',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1050000,
        maxTokens: 128000,
      },
      {
        id: 'gpt-6.1-terra',
        name: 'GPT-6.1 Terra',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1050000,
        maxTokens: 128000,
      },
      {
        id: 'gpt-6-luna',
        name: 'GPT-6 Luna',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1050000,
        maxTokens: 128000,
      },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnvHint: 'ANTHROPIC_API_KEY',
    keyHints: {
      zh: '在 platform.claude.com → Settings → API keys 创建',
      en: 'Create one at platform.claude.com → Settings → API keys',
    },
    docsUrl: 'https://platform.claude.com/docs/en/models/overview',
    models: [
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      {
        id: 'claude-sonnet-5-5',
        name: 'Claude Sonnet 5.5',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      {
        id: 'claude-haiku-5-5',
        name: 'Claude Haiku 5.5',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1000000,
        maxTokens: 128000,
      },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini（OpenAI 兼容端点）',
    labels: { en: 'Google Gemini (OpenAI-compatible endpoint)' },
    api: 'openai-completions',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnvHint: 'GEMINI_API_KEY',
    keyHints: {
      zh: '在 aistudio.google.com → API keys 创建（也接受 GOOGLE_API_KEY）',
      en: 'Create one at aistudio.google.com → API keys (GOOGLE_API_KEY also accepted)',
    },
    docsUrl: 'https://ai.google.dev/gemini-api/docs/models',
    models: [
      {
        id: 'gemini-4-carbon',
        name: 'Gemini 4 Carbon',
        reasoning: true,
        input: ['text', 'image', 'audio', 'video'],
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: 'gemini-4-neon',
        name: 'Gemini 4 Neon',
        reasoning: true,
        input: ['text', 'image', 'audio', 'video'],
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: 'gemini-4-hydrogen',
        name: 'Gemini 4 Hydrogen',
        reasoning: true,
        input: ['text', 'image', 'audio', 'video'],
        contextWindow: 1048576,
        maxTokens: 65536,
      },
    ],
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    api: 'openai-completions',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnvHint: 'XAI_API_KEY',
    keyHints: {
      zh: '在 console.x.ai → API Keys 创建',
      en: 'Create one at console.x.ai → API Keys',
    },
    docsUrl: 'https://docs.x.ai/developers/models',
    // maxTokens：官方全站未公布逐模型输出上限（只有 API 级默认 128000），按口径留空。
    models: [
      { id: 'grok-4.7', name: 'Grok 4.7', reasoning: true, input: ['text', 'image'], contextWindow: 500000 },
      { id: 'grok-4.6', name: 'Grok 4.6', reasoning: true, input: ['text', 'image'], contextWindow: 500000 },
      { id: 'grok-4.3', name: 'Grok 4.3', reasoning: true, input: ['text', 'image'], contextWindow: 1000000 },
    ],
    modes: [
      {
        // 美国区域端点：**同一把 key 两个端点通用**，但模型清单收窄到只有两个。
        id: 'us-region',
        label: '美国区域端点',
        labels: { en: 'US regional endpoint' },
        api: 'openai-completions',
        baseUrl: 'https://us.api.x.ai/v1',
        notes: {
          zh: '同一把 key 可用，但**仅** grok-4.7 / grok-4.6 在此端点上提供；其它模型返回 404',
          en: 'The same key works here, but only grok-4.7 / grok-4.6 are served; other models return 404',
        },
        models: [
          { id: 'grok-4.7', name: 'Grok 4.7', reasoning: true, input: ['text', 'image'], contextWindow: 500000 },
          { id: 'grok-4.6', name: 'Grok 4.6', reasoning: true, input: ['text', 'image'], contextWindow: 500000 },
        ],
      },
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    api: 'openai-completions',
    // 官方 OpenAI 格式入口（public preview）；native 格式端点为 `https://api.mistral.ai/v1`，
    // 生态常直接当 OpenAI 兼容用——若该端点行为变化，可在此改选。
    baseUrl: 'https://api.mistral.ai/openai/v1',
    apiKeyEnvHint: 'MISTRAL_API_KEY',
    keyHints: {
      zh: '在 console.mistral.ai → API Keys 创建',
      en: 'Create one at console.mistral.ai → API Keys',
    },
    docsUrl: 'https://docs.mistral.ai/models',
    // maxTokens：官方只规定「输入+输出不超上下文」，无逐模型输出上限，按口径留空。
    models: [
      {
        id: 'mistral-large-4',
        name: 'Mistral Large 4',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1000000,
      },
      {
        id: 'mistral-small-2603',
        name: 'Mistral Small 4',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 262144,
      },
      { id: 'codestral-2508', name: 'Codestral', input: ['text'], contextWindow: 128000 },
    ],
    modes: [
      {
        // native Mistral 格式（非 OpenAI 兼容），官方文档的主入口。
        id: 'native',
        label: 'Mistral 原生协议',
        labels: { en: 'Mistral native protocol' },
        api: 'openai-completions',
        baseUrl: 'https://api.mistral.ai/v1',
        notes: {
          zh: '⚠️ 这是 Mistral 自有 Chat Completions 格式，不是 OpenAI 兼容协议；选中前请确认请求/响应体差异',
          en: '⚠️ This is Mistral’s own Chat Completions format, not an OpenAI-compatible protocol; check request/response differences first',
        },
      },
    ],
  },
  {
    id: 'groq',
    label: 'Groq',
    api: 'openai-completions',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnvHint: 'GROQ_API_KEY',
    keyHints: {
      zh: '在 console.groq.com → API Keys 创建',
      en: 'Create one at console.groq.com → API Keys',
    },
    docsUrl: 'https://console.groq.com/docs/models',
    models: [
      {
        id: 'openai/gpt-oss-120b',
        name: 'GPT OSS 120B',
        reasoning: true,
        input: ['text'],
        contextWindow: 131072,
        maxTokens: 65536,
      },
      {
        id: 'openai/gpt-oss-20b',
        name: 'GPT OSS 20B',
        reasoning: true,
        input: ['text'],
        contextWindow: 131072,
        maxTokens: 65536,
      },
      {
        // 官方标注 Preview：可能随时下线，只作可选档，不作唯一默认。
        id: 'qwen/qwen3.8-27b',
        name: 'Qwen3.8 27B (Preview)',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 131072,
        maxTokens: 16384,
      },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvHint: 'OPENROUTER_API_KEY',
    keyHints: {
      zh: '在 openrouter.ai/keys 创建（建议同时设置额度上限）',
      en: 'Create one at openrouter.ai/keys (set a spend limit too)',
    },
    docsUrl: 'https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties',
    // maxTokens 取目录里 top_provider.max_completion_tokens（首选 provider 的上限），随路由变化，只作参考。
    models: [
      {
        id: 'anthropic/claude-sonnet-5.5',
        name: 'Anthropic: Claude Sonnet 5.5',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      {
        id: 'openai/gpt-6.2-astra',
        name: 'OpenAI: GPT-6.2 Astra',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1050000,
        maxTokens: 128000,
      },
      {
        id: 'google/gemini-4-neon',
        name: 'Google: Gemini 4 Neon',
        reasoning: true,
        input: ['text', 'image', 'audio', 'video'],
        contextWindow: 1048576,
        // 取目录里的 top_provider.max_completion_tokens（占窗口 90%）。数值真实但预留极大，
        // 会压低输入预算；需要长输入时由用户按上游 provider 实况下调。
        maxTokens: 943718,
      },
    ],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    api: 'openai-completions',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnvHint: 'CEREBRAS_API_KEY',
    keyHints: {
      zh: '在 cloud.cerebras.ai → API Keys 创建',
      en: 'Create one at cloud.cerebras.ai → API Keys',
    },
    docsUrl: 'https://inference-docs.cerebras.ai/models/overview',
    // Shared Inference 仅这两个模型；其余（gemma / kimi / glm 等）属 Dedicated，需自建 endpoint。
    models: [
      {
        id: 'gpt-oss-120b',
        name: 'OpenAI GPT OSS 120B',
        reasoning: true,
        input: ['text'],
        contextWindow: 131072,
        maxTokens: 40960,
      },
      {
        id: 'qwen-3.8-27b',
        name: 'Qwen 3.8 27B',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 131072,
        maxTokens: 40960,
      },
    ],
  },

  // ── 国内 ────────────────────────────────────────────────────────────────
  {
    id: 'deepseek',
    label: 'DeepSeek',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnvHint: 'DEEPSEEK_API_KEY',
    keyHints: {
      zh: '在 platform.deepseek.com → API keys 创建',
      en: 'Create one at platform.deepseek.com → API keys',
    },
    docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    models: [
      {
        id: 'deepseek-flash',
        name: 'DeepSeek-V4.1-Flash',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1048576,
        maxTokens: 393216,
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        reasoning: true,
        input: ['text'],
        contextWindow: 1048576,
        maxTokens: 393216,
      },
    ],
    modes: [
      {
        // 官方首页两个 base_url 并列：OpenAI 与 Anthropic，同一把 key、同一批模型。
        id: 'anthropic',
        label: 'Anthropic 兼容',
        labels: { en: 'Anthropic-compatible' },
        api: 'anthropic-messages',
        baseUrl: 'https://api.deepseek.com/anthropic',
      },
    ],
  },
  {
    id: 'qwen',
    label: '通义千问（百炼 DashScope）',
    labels: { en: 'Qwen (DashScope)' },
    api: 'openai-completions',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnvHint: 'DASHSCOPE_API_KEY',
    keyHints: {
      zh: '在百炼控制台 bailian.console.aliyun.com → API-KEY 创建（Key 按地域绑定，跨地域调用会 401）',
      en: 'Create one at the DashScope console (bailian.console.aliyun.com) → API-KEY (keys are region-bound; cross-region calls return 401)',
    },
    docsUrl: 'https://help.aliyun.com/zh/model-studio/text-generation-model',
    models: [
      {
        id: 'qwen4-max',
        name: 'Qwen4-Max',
        reasoning: true,
        input: ['text', 'image', 'video'],
        contextWindow: 1000000,
        maxTokens: 131072,
      },
      {
        id: 'qwen3.7-plus',
        name: 'Qwen3.7-Plus',
        reasoning: true,
        input: ['text', 'image', 'video'],
        contextWindow: 1000000,
        maxTokens: 131072,
      },
      {
        id: 'qwen3.8-flash',
        name: 'Qwen3.8-Flash',
        reasoning: true,
        input: ['text', 'image', 'video'],
        contextWindow: 1000000,
        maxTokens: 131072,
      },
    ],
    modes: [
      {
        // Coding Plan：独立域名 + 专属 key 前缀 sk-sp-（与 sk- 不通用，混用会按按量扣费或 401）。
        id: 'coding-plan',
        label: 'Coding Plan（订阅制）',
        labels: { en: 'Coding Plan (subscription)' },
        api: 'openai-completions',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        apiKeyEnvHint: 'DASHSCOPE_CODING_PLAN_API_KEY',
        notes: {
          zh: '专属 sk-sp- key。仅限交互式 AI 编程工具使用，禁止脚本/后端/Dify/n8n/Postman 调用（官方会停订阅或封 key）；可用模型以套餐页为准',
          en: 'Dedicated sk-sp- key. For interactive AI coding tools only — scripts, backends, Dify/n8n/Postman are prohibited (the vendor suspends plans or blocks keys)',
        },
      },
      {
        id: 'coding-plan-anthropic',
        label: 'Coding Plan（Anthropic 兼容）',
        labels: { en: 'Coding Plan (Anthropic-compatible)' },
        api: 'anthropic-messages',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
        apiKeyEnvHint: 'DASHSCOPE_CODING_PLAN_API_KEY',
        notes: {
          zh: '同一套餐 key；仅限交互式 AI 编程工具，禁止脚本与后端调用',
          en: 'Same plan key. Interactive AI coding tools only — no scripts or backend calls',
        },
      },
      {
        // Token Plan：另一套独立 host，同为 sk-sp- 套餐 key。
        id: 'token-plan',
        label: 'Token Plan（个人/团队订阅）',
        labels: { en: 'Token Plan (personal/team)' },
        api: 'openai-completions',
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        apiKeyEnvHint: 'DASHSCOPE_TOKEN_PLAN_API_KEY',
        notes: {
          zh: '套餐 key（sk-sp-）；团队版模型池含 qwen4-max / qwen3.8-max / deepseek / kimi / glm / MiniMax 等。同样仅限交互式编程与 Agent 工具，禁止脚本与后端调用',
          en: 'Plan key (sk-sp-). The team pool includes qwen4-max / qwen3.8-max / deepseek / kimi / glm / MiniMax, etc. Interactive coding and agent tools only — no scripts or backends',
        },
      },
      {
        id: 'token-plan-anthropic',
        label: 'Token Plan（Anthropic 兼容）',
        labels: { en: 'Token Plan (Anthropic-compatible)' },
        api: 'anthropic-messages',
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
        apiKeyEnvHint: 'DASHSCOPE_TOKEN_PLAN_API_KEY',
        notes: {
          zh: '同一 Token Plan key；仅限交互式编程与 Agent 工具，禁止脚本与后端调用',
          en: 'Same Token Plan key. Interactive coding/agent tools only — no scripts or backends',
        },
      },
    ],
  },
  {
    id: 'kimi',
    label: 'Kimi（月之暗面）',
    labels: { en: 'Kimi (Moonshot)' },
    api: 'openai-completions',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnvHint: 'MOONSHOT_API_KEY',
    keyHints: {
      zh: '在 platform.kimi.com → API Key 管理创建',
      en: 'Create one at platform.kimi.com → API Key management',
    },
    docsUrl: 'https://platform.kimi.com/docs/models',
    models: [
      {
        id: 'kimi-k3.1-pro',
        name: 'Kimi K3.1 Pro',
        reasoning: true,
        input: ['text', 'image', 'video'],
        contextWindow: 1048576,
        maxTokens: 131072,
      },
      {
        id: 'kimi-k3.1-pro-highspeed',
        name: 'Kimi K3.1 Pro Highspeed',
        reasoning: true,
        input: ['text', 'image', 'video'],
        contextWindow: 1048576,
        maxTokens: 131072,
      },
      {
        id: 'kimi-k3',
        name: 'Kimi K3',
        reasoning: true,
        input: ['text', 'image', 'video'],
        contextWindow: 1048576,
        maxTokens: 131072,
      },
    ],
    modes: [
      {
        // 官方明写「API 开放平台按量计费、无订阅制方案」——这里只有协议差异，同一把 key。
        id: 'anthropic',
        label: 'Anthropic 兼容',
        labels: { en: 'Anthropic-compatible' },
        api: 'anthropic-messages',
        baseUrl: 'https://api.moonshot.cn/anthropic',
      },
    ],
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    labels: { en: 'Zhipu GLM' },
    api: 'openai-completions',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnvHint: 'ZAI_API_KEY',
    keyHints: {
      zh: '在 bigmodel.cn → 用户中心 → API Keys 创建（个人/团队/标准 API 三类 Key 互不通用；旧称 ZHIPU_API_KEY）',
      en: 'Create one at bigmodel.cn → user center → API Keys (personal / team / standard API keys are not interchangeable; formerly ZHIPU_API_KEY)',
    },
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/model-overview',
    models: [
      {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        reasoning: true,
        input: ['text'],
        contextWindow: 1000000,
        maxTokens: 131072,
      },
      {
        id: 'glm-5.3-flash',
        name: 'GLM-5.3-Flash',
        reasoning: true,
        input: ['text', 'image', 'video'],
        contextWindow: 1000000,
        maxTokens: 131072,
      },
    ],
    modes: [
      {
        // 标准的 Anthropic 兼容面：**与套餐共用同一 URL**，扣哪类额度由 key 类型决定。
        id: 'anthropic',
        label: 'Anthropic 兼容',
        labels: { en: 'Anthropic-compatible' },
        api: 'anthropic-messages',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        keyHints: {
          zh: '该端点标准与套餐共用：用标准 key 按量扣费，用套餐 key 扣套餐额度',
          en: 'Shared by standard and plan keys: a standard key bills per token, a plan key draws from the plan quota',
        },
      },
      {
        // Coding Plan：仅 OpenAI Chat 换了路径，Anthropic 端点上一条已覆盖（不要复制成两条）。
        id: 'coding-plan',
        label: 'Coding Plan（订阅制）',
        labels: { en: 'Coding Plan (subscription)' },
        api: 'openai-completions',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        apiKeyEnvHint: 'ZAI_CODING_PLAN_API_KEY',
        notes: {
          zh: '套餐 key 与标准 key 分类管理、互不通用；套餐仅覆盖 GLM-5.4 / 5.3 / 5.3-Flash（GLM-5.4 建议客户端窗口设 512000）',
          en: 'Plan keys are managed separately from standard keys. The plan covers only GLM-5.4 / 5.3 / 5.3-Flash (use a 512000 window for GLM-5.4)',
        },
      },
    ],
  },
  {
    id: 'doubao',
    label: '火山方舟 豆包',
    labels: { en: 'Doubao (Volcengine Ark)' },
    api: 'openai-completions',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyEnvHint: 'ARK_API_KEY',
    keyHints: {
      zh: '在 console.volcengine.com/ark → API Key 管理创建',
      en: 'Create one at console.volcengine.com/ark → API Key management',
    },
    docsUrl: 'https://docs.volcengine.com/docs/ark/model-list',
    models: [
      {
        id: 'doubao-seed-2-1-pro-260915',
        name: 'Doubao Seed 2.1 Pro',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1048576,
        maxTokens: 262144,
      },
      {
        id: 'doubao-seed-2-1-lite-260915',
        name: 'Doubao Seed 2.1 Lite',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1048576,
        maxTokens: 262144,
      },
      {
        // 官方「最大回答 256K」等于整窗（256K）——把它当输出预留会让输入预算归零
        // （分配器 input+output ≤ contextWindow，infeasible 后退化为 1k 预算），故留空交给比例回退。
        id: 'doubao-seed-2-1-turbo-260628',
        name: 'Doubao Seed 2.1 Turbo',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 262144,
      },
    ],
    modes: [
      {
        // Agent Plan（订阅）：专属 baseUrl + **专属 API Key**（与按量 key 不通用）。
        id: 'agent-plan',
        label: 'Agent Plan（订阅制）',
        labels: { en: 'Agent Plan (subscription)' },
        api: 'anthropic-messages',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan',
        apiKeyEnvHint: 'ARK_AGENT_PLAN_API_KEY',
        notes: {
          zh: '专属端点与专属 key（在控制台 Agent Plan 页获取，与按量 key 不通用）；额度仅限交互式 Agent/编程工具使用，禁止脚本与后端调用',
          en: 'Dedicated endpoint and key (from the console Agent Plan page; not interchangeable with pay-as-you-go keys). Quota is for interactive agent/coding tools only — scripts and backend calls are prohibited',
        },
      },
      {
        id: 'agent-plan-openai',
        label: 'Agent Plan（OpenAI 兼容）',
        labels: { en: 'Agent Plan (OpenAI-compatible)' },
        api: 'openai-completions',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
        apiKeyEnvHint: 'ARK_AGENT_PLAN_API_KEY',
        notes: {
          zh: '同一 Agent Plan 额度，OpenAI 协议；key 与上面一条相同',
          en: 'Same Agent Plan quota over the OpenAI protocol; same key as the entry above',
        },
      },
      {
        id: 'coding-plan',
        label: 'Coding Plan（订阅制，Anthropic 兼容）',
        labels: { en: 'Coding Plan (subscription, Anthropic-compatible)' },
        api: 'anthropic-messages',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
        notes: {
          zh: '**key 与按量版通用，但必须走此端点**：误用 /api/v3 会按按量计费。额度仅限交互式编程工具，禁止脚本与后端调用',
          en: 'The key is the same as pay-as-you-go, but you must use this endpoint — calling /api/v3 bills per token. Quota is for interactive coding tools only; scripts and backend calls are prohibited',
        },
      },
      {
        id: 'coding-plan-openai',
        label: 'Coding Plan（OpenAI 兼容）',
        labels: { en: 'Coding Plan (OpenAI-compatible)' },
        api: 'openai-completions',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
        notes: {
          zh: '同一 Coding Plan 额度，OpenAI 协议；同样不要用 /api/v3',
          en: 'Same Coding Plan quota over the OpenAI protocol; again, do not use /api/v3',
        },
      },
    ],
  },
  {
    id: 'mimo',
    label: '小米 MiMo',
    labels: { en: 'Xiaomi MiMo' },
    api: 'openai-completions',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    apiKeyEnvHint: 'MIMO_API_KEY',
    keyHints: {
      zh: '在 platform.xiaomimimo.com → 控制台 → API Keys 创建',
      en: 'Create one at platform.xiaomimimo.com → console → API Keys',
    },
    docsUrl: 'https://mimo.mi.com/docs/zh-CN/welcome',
    models: [
      {
        id: 'mimo-v2.6-pro',
        name: 'MiMo V2.6 Pro',
        reasoning: true,
        input: ['text', 'image', 'audio', 'video'],
        contextWindow: 1048576,
        maxTokens: 131072,
      },
      {
        id: 'mimo-v2.6-flash',
        name: 'MiMo V2.6 Flash',
        reasoning: true,
        input: ['text', 'image', 'audio', 'video'],
        contextWindow: 1048576,
        maxTokens: 131072,
      },
    ],
    modes: [
      {
        // Token Plan（订阅）：独立域名 + 独立 key 前缀 tp-/ttp-（与 sk- 不通用）。
        id: 'token-plan',
        label: 'Token Plan（订阅制）',
        labels: { en: 'Token Plan (subscription)' },
        api: 'openai-completions',
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
        apiKeyEnvHint: 'MIMO_TOKEN_PLAN_API_KEY',
        notes: {
          zh: '订阅套餐专用端点：个人 key 前缀 tp-、团队 ttp-，与 sk- 完全不通用。官方提醒以 Token Plan 页面显示的域名为准（另有新加坡 token-plan-sgp / 欧洲 token-plan-ams 集群）',
          en: 'Subscription endpoint: personal keys use tp-, team keys ttp-; never interchangeable with sk-. The vendor says to use the domain shown on your Token Plan page (sgp / ams clusters also exist)',
        },
      },
      {
        // 同一 Token Plan 域名下的 Anthropic 兼容面（baseUrl 不带 /v1）。
        id: 'token-plan-anthropic',
        label: 'Token Plan（Anthropic 兼容）',
        labels: { en: 'Token Plan (Anthropic-compatible)' },
        api: 'anthropic-messages',
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
        apiKeyEnvHint: 'MIMO_TOKEN_PLAN_API_KEY',
        notes: {
          zh: '供 Claude Code 等 Anthropic 协议客户端使用；同样需要 tp-/ttp- 套餐 key',
          en: 'For Anthropic-protocol clients (Claude Code etc.); same tp-/ttp- plan key required',
        },
      },
    ],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    api: 'openai-completions',
    baseUrl: 'https://api.minimax.cn/v1',
    apiKeyEnvHint: 'MINIMAX_API_KEY',
    keyHints: {
      zh: '在 platform.minimaxi.com → User Center → API Keys 创建（海外账号需把 baseUrl 改为 https://api.minimax.io/v1）',
      en: 'Create one at platform.minimax.io → User Center → API Keys (accounts outside mainland China must switch baseUrl to https://api.minimax.io/v1)',
    },
    docsUrl: 'https://platform.minimaxi.com/docs/api-reference/text-openai-api',
    models: [
      {
        id: 'MiniMax-M3.1-Flash',
        name: 'MiniMax M3.1 Flash',
        reasoning: true,
        input: ['text', 'image', 'video'],
        contextWindow: 1000000,
        maxTokens: 131072,
      },
      // 输出上限：官方只公布 M3.1-Flash 的推荐/上限值，M3 未逐字给数，按口径留空。
      { id: 'MiniMax-M3', name: 'MiniMax M3', reasoning: true, input: ['text', 'image', 'video'], contextWindow: 1000000 },
    ],
    modes: [
      {
        // 官方推荐的 Anthropic 兼容端点（同 host，路径 /anthropic）。
        id: 'anthropic',
        label: 'Anthropic 兼容（官方推荐）',
        labels: { en: 'Anthropic-compatible (vendor-recommended)' },
        api: 'anthropic-messages',
        baseUrl: 'https://api.minimax.cn/anthropic',
      },
      {
        // M Plan（订阅）**不换端点、只换 key**：这里只做标注，避免用户以为要换 baseUrl。
        id: 'm-plan',
        label: 'M Plan（订阅制，同端点换 key）',
        labels: { en: 'M Plan (subscription, same endpoint/different key)' },
        api: 'openai-completions',
        baseUrl: 'https://api.minimax.cn/v1',
        apiKeyEnvHint: 'MINIMAX_M_PLAN_API_KEY',
        notes: {
          zh: '订阅 M Plan 只换 key、不换端点：在订阅管理 → M Plan 查看专属 key（与按量 key 不通用）；额度按套餐档位（Go / Explore / Build）',
          en: 'M Plan changes the key only, not the endpoint: find the plan key under Subscription → M Plan (not interchangeable with pay-as-you-go keys)',
        },
      },
    ],
  },
  {
    id: 'qianfan',
    label: '百度千帆 ERNIE',
    labels: { en: 'ERNIE (Baidu Qianfan)' },
    api: 'openai-completions',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    apiKeyEnvHint: 'QIANFAN_API_KEY',
    keyHints: {
      zh: '在 console.bce.baidu.com/qianfan → 系统管理 → 创建 API Key（v2 Bearer key，不是 IAM AK/SK）',
      en: 'Create one at console.bce.baidu.com/qianfan → System management → API Key (v2 bearer key, not IAM AK/SK)',
    },
    docsUrl: 'https://cloud.baidu.com/doc/qianfan/s/Hmh4suq26',
    models: [
      {
        // 官方「上下文 1M / 最大输出 1M（含思维链）」——输出上限等于整窗，作输出预留会让
        // 输入预算归零，故留空交给比例回退（窗口仍按 1M 计）。
        id: 'ernie-5.5-flash-preview',
        name: 'ERNIE 5.5 Flash Preview',
        reasoning: true,
        input: ['text'],
        contextWindow: 1048576,
      },
      {
        id: 'ernie-light-dt-1.0',
        name: 'ERNIE Light DT 1.0',
        reasoning: true,
        input: ['text'],
        contextWindow: 1048576,
        maxTokens: 131072,
      },
      { id: 'ernie-5.1', name: 'ERNIE 5.1', input: ['text'], contextWindow: 131072, maxTokens: 65536 },
    ],
    modes: [
      {
        // Token Plan 个人版（Coding Plan 全档已于 2026-07-13 停售，不再列）。
        id: 'token-plan',
        label: 'Token Plan 个人版（订阅）',
        labels: { en: 'Token Plan personal (subscription)' },
        api: 'openai-completions',
        baseUrl: 'https://qianfan.baidubce.com/v2/tokenplan/personal',
        apiKeyEnvHint: 'QIANFAN_TOKEN_PLAN_API_KEY',
        notes: {
          zh: '专属 key（在「我的订阅」页获取，与常规千帆 key 不同）；模型池以订阅页为准',
          en: 'Dedicated key from the My Subscription page (different from a regular Qianfan key); the model pool is listed there',
        },
      },
      {
        id: 'token-plan-anthropic',
        label: 'Token Plan 个人版（Anthropic 兼容）',
        labels: { en: 'Token Plan personal (Anthropic-compatible)' },
        api: 'anthropic-messages',
        baseUrl: 'https://qianfan.baidubce.com/anthropic/tokenplan/personal',
        apiKeyEnvHint: 'QIANFAN_TOKEN_PLAN_API_KEY',
        notes: {
          zh: '同一 Token Plan 专属 key；模型池以订阅页为准',
          en: 'Same dedicated Token Plan key; the model pool is listed on the subscription page',
        },
      },
    ],
  },
  {
    id: 'hunyuan',
    label: '腾讯混元',
    labels: { en: 'Tencent Hunyuan' },
    api: 'openai-completions',
    // 新平台 TokenHub（原平台 api.hunyuan.cloud.tencent.com/v1 仍可用但已停止新购）。
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    apiKeyEnvHint: 'HUNYUAN_API_KEY',
    keyHints: {
      zh: '在 console.cloud.tencent.com/tokenhub → API Key 管理创建',
      en: 'Create one at console.cloud.tencent.com/tokenhub → API Key management',
    },
    docsUrl: 'https://cloud.tencent.com/document/product/1823/130051',
    models: [
      {
        id: 'hy4',
        name: 'Hunyuan Hy4',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: 'hy4-flash',
        name: 'Hunyuan Hy4 Flash',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      { id: 'hy3', name: 'Hunyuan Hy3', reasoning: true, input: ['text'], contextWindow: 262144, maxTokens: 131072 },
    ],
    modes: [
      {
        // 旧平台 Anthropic 兼容面（已停止新购，老用户仍可用）。
        id: 'anthropic',
        label: 'Anthropic 兼容（旧平台）',
        labels: { en: 'Anthropic-compatible (legacy platform)' },
        api: 'anthropic-messages',
        baseUrl: 'https://api.hunyuan.cloud.tencent.com/anthropic',
        apiKeyEnvHint: 'HUNYUAN_LEGACY_API_KEY',
        notes: {
          zh: '旧平台已停止新购，仅存量用户可用；模型清单与 TokenHub 不同',
          en: 'The legacy platform no longer sells new keys; existing users only. Its model list differs from TokenHub',
        },
      },
      {
        id: 'token-plan',
        label: 'Token Plan 企业版（订阅，广州）',
        labels: { en: 'Token Plan enterprise (subscription, Guangzhou)' },
        api: 'openai-completions',
        baseUrl: 'https://tokenhub.tencentmaas.com/plan/v3',
        apiKeyEnvHint: 'HUNYUAN_TOKEN_PLAN_API_KEY',
        notes: {
          zh: '套餐内 key（每万积分 1 个，续费不及时立即失效）；地域硬边界：广州 key 不能调新加坡端点。仅限交互式编程/Agent 工具',
          en: 'Plan key (one per 10k credits; expires immediately if renewal is late). Regions are hard boundaries. Interactive coding/agent tools only',
        },
      },
      {
        id: 'token-plan-anthropic',
        label: 'Token Plan 企业版（Anthropic 兼容）',
        labels: { en: 'Token Plan enterprise (Anthropic-compatible)' },
        api: 'anthropic-messages',
        baseUrl: 'https://tokenhub.tencentmaas.com/plan/anthropic',
        apiKeyEnvHint: 'HUNYUAN_TOKEN_PLAN_API_KEY',
        notes: {
          zh: '同一 Token Plan key；地域硬边界（广州 key 不能调新加坡端点）',
          en: 'Same Token Plan key. Regions are hard boundaries — a Guangzhou key cannot call the Singapore endpoint',
        },
      },
      {
        id: 'coding-plan',
        label: 'Coding Plan（订阅制，专属 sk-sp- key）',
        labels: { en: 'Coding Plan (subscription, dedicated sk-sp- key)' },
        api: 'openai-completions',
        baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3',
        apiKeyEnvHint: 'HUNYUAN_CODING_PLAN_API_KEY',
        notes: {
          zh: '专属 sk-sp- key（与预付费/后付费 sk- 不通用）；仅 Auto（tc-code-latest），不支持多模态',
          en: 'Dedicated sk-sp- key (not interchangeable with sk-). Auto (tc-code-latest) only, no multimodal',
        },
      },
      {
        id: 'coding-plan-anthropic',
        label: 'Coding Plan（Anthropic 兼容）',
        labels: { en: 'Coding Plan (Anthropic-compatible)' },
        api: 'anthropic-messages',
        baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/anthropic',
        apiKeyEnvHint: 'HUNYUAN_CODING_PLAN_API_KEY',
        notes: {
          zh: '同一 Coding Plan key；仅 Auto（tc-code-latest），不支持多模态',
          en: 'Same Coding Plan key. Auto (tc-code-latest) only — no multimodal',
        },
      },
    ],
  },
  {
    id: 'spark',
    label: '讯飞星火',
    labels: { en: 'iFLYTEK Spark' },
    api: 'openai-completions',
    // X2 端点（新一代推理）。老版本模型走另一套域名，见 keyHints。
    baseUrl: 'https://spark-api-open.xf-yun.com/x2',
    apiKeyEnvHint: 'SPARK_API_KEY',
    keyHints: {
      zh: '在 console.xfyun.cn 对应服务页取「http服务接口认证信息」里的 APIPassword（各代次共用）',
      en: 'Copy the APIPassword from console.xfyun.cn (HTTP service credentials); shared across model generations',
    },
    docsUrl: 'https://www.xfyun.cn/doc/spark/X1http.html',
    // 只列 spark-x：它与 /x2 端点绑定；其它代次（X1.5 / 老域）在各 modes 里选。
    models: [
      {
        // 官方给的是两条独立上限：输入 64K / 输出 128K；按「input+output ≤ contextWindow」
        // 不变量折算成总窗口 196,608，输出预留 131,072 后正好剩 64K 输入。
        id: 'spark-x',
        name: 'Spark X2',
        reasoning: true,
        input: ['text'],
        contextWindow: 196608,
        maxTokens: 131072,
      },
    ],
    modes: [
      {
        // 星火的「多接入方式」是按模型代次分路径，不是订阅制——同一把 APIPassword。
        id: 'x1.5',
        label: 'X1.5 代次（/v2）',
        labels: { en: 'X1.5 generation (/v2)' },
        api: 'openai-completions',
        baseUrl: 'https://spark-api-open.xf-yun.com/v2',
        notes: {
          zh: 'max_tokens 上限 65535（X2 为 131072）；model 参数仍传 spark-x',
          en: 'max_tokens caps at 65535 (X2 allows 131072); the model parameter is still spark-x',
        },
      },
      {
        id: 'legacy',
        label: '老版本模型（4.0Ultra / pro-128k / lite）',
        labels: { en: 'Legacy models (4.0Ultra / pro-128k / lite)' },
        api: 'openai-completions',
        baseUrl: 'https://spark-api-open.xf-yun.com/v1',
        notes: {
          zh: '这些模型的 id 与 /x2 域不兼容，选中后请按官方模型页改填 models',
          en: 'These model ids are incompatible with /x2; adjust the model list per the vendor page after selecting',
        },
      },
    ],
  },
  {
    id: 'stepfun',
    label: '阶跃星辰',
    labels: { en: 'StepFun' },
    api: 'openai-completions',
    baseUrl: 'https://api.stepfun.com/v1',
    apiKeyEnvHint: 'STEP_API_KEY',
    keyHints: {
      zh: '在 platform.stepfun.com → 项目管理 → API Key 创建',
      en: 'Create one at platform.stepfun.com → Project management → API Key',
    },
    docsUrl: 'https://platform.stepfun.com/docs/zh/guides/models/list',
    models: [
      {
        id: 'step-5-preview',
        name: 'Step 5 Preview',
        reasoning: true,
        input: ['text', 'image', 'video'],
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      // 这两代的单次输出上限官方未给硬数（max_tokens 默认 INF），按口径留空。
      {
        id: 'step-3.7-flash',
        name: 'Step 3.7 Flash',
        reasoning: true,
        input: ['text', 'image', 'video'],
        contextWindow: 262144,
      },
      { id: 'step-3.5-flash', name: 'Step 3.5 Flash', reasoning: true, input: ['text'], contextWindow: 262144 },
    ],
    modes: [
      {
        // Step Plan（订阅）：同一把 key，走 plan 路径消耗套餐额度。
        id: 'step-plan',
        label: 'Step Plan（订阅制）',
        labels: { en: 'Step Plan (subscription)' },
        api: 'openai-completions',
        baseUrl: 'https://api.stepfun.com/step_plan/v1',
        notes: {
          zh: '同一把 Step key：走此路径消耗套餐额度，走 /v1 则走按量额度',
          en: 'Same Step key: calls to this path draw from the plan quota; /v1 draws from pay-as-you-go credit',
        },
      },
      {
        // 关键坑：Anthropic 客户端会自己拼 /v1/messages，所以 baseUrl 不能带 /v1。
        id: 'step-plan-anthropic',
        label: 'Step Plan（Anthropic 兼容）',
        labels: { en: 'Step Plan (Anthropic-compatible)' },
        api: 'anthropic-messages',
        baseUrl: 'https://api.stepfun.com/step_plan',
        notes: {
          zh: 'baseUrl 刻意不带 /v1：Anthropic 协议会自动拼 /v1/messages',
          en: 'The baseUrl intentionally omits /v1: the Anthropic protocol appends /v1/messages itself',
        },
      },
    ],
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    labels: { en: 'SiliconFlow' },
    api: 'openai-completions',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyEnvHint: 'SILICONFLOW_API_KEY',
    keyHints: {
      zh: '在 cloud.siliconflow.cn → API 密钥 → 新建 API 密钥（模型清单与上下文/输出参数见「模型广场」，请按所选模型手填）',
      en: 'Create one at cloud.siliconflow.cn → API keys (model list and context/output limits live in the Model Square — fill them in per model)',
    },
    docsUrl: 'https://docs.siliconflow.cn/docs/userguide/quickstart',
    // 聚合平台：静态文档不列逐模型参数，`GET /v1/models` 需鉴权 → 参数留空；下列 id 取自官方文档示例，
    // 实际可用清单以「模型广场」为准，用户可在表单里替换。
    models: [
      { id: 'deepseek-ai/DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash' },
      { id: 'Qwen/Qwen3.6-27B', name: 'Qwen3.6 27B' },
    ],
    modes: [
      {
        // 实测（2026-11-25）：POST /v1/messages → 401（路由存在）；POST /messages → 404。
        // 故 baseUrl 取 host（不带 /v1），anthropic-messages 自动拼 /v1/messages。
        id: 'anthropic',
        label: 'Anthropic 兼容',
        labels: { en: 'Anthropic-compatible' },
        api: 'anthropic-messages',
        baseUrl: 'https://api.siliconflow.cn',
      },
    ],
  },

  // ── 本地 / 自定义 ───────────────────────────────────────────────────────
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    labels: { en: 'Ollama (Local)' },
    api: 'openai-completions',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyEnvHint: '',
    keyHints: {
      zh: '本地运行无需 key（ollama.com 下载安装 Ollama 后即可；客户端要求非空时可填任意值如 ollama）',
      en: 'No key needed for local use (install Ollama from ollama.com); if the client insists on a value, use any string such as ollama',
    },
    docsUrl: 'https://ollama.com/library',
    // 上下文取自模型库页；Ollama 不公布逐模型输出上限，maxTokens 留空。
    // 模型名保持纯 id（label 已写明「本地」，name 无本地化字段，带中文会漏到英文界面）。
    models: [
      { id: 'qwen3.5', name: 'Qwen3.5', reasoning: true, input: ['text', 'image'], contextWindow: 262144 },
      { id: 'gemma4:31b', name: 'Gemma 4 31B', reasoning: true, input: ['text', 'image'], contextWindow: 262144 },
      { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', reasoning: true, input: ['text'], contextWindow: 131072 },
    ],
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    labels: { en: 'Custom (OpenAI-compatible)' },
    api: 'openai-completions',
    baseUrl: '',
    apiKeyEnvHint: 'API_KEY',
    keyHints: {
      zh: '填写服务方给你的 key（若服务不要鉴权可留空）',
      en: 'Use the key from your provider (leave empty if the service needs no auth)',
    },
    // 唯一允许空 models 的条目：清单由用户填。expandProviderPreset 对 custom 返回 `models: []`，
    // 调用方必须先补模型才能过 `ModelProviderConfigSchema.models.min(1)`（向导与设置面板均已兜底）。
    //
    // 已知缺口（未在本提交修，待定）：`apiKeyEnvHint: 'API_KEY'` 会让向导的 api-key 步强制非空，
    // 无鉴权的自建端点（本地 vLLM / LM Studio）过不去。修法需要区分「必须有 key / 可选 key」，
    // 属向导校验语义变更，不在预设表范围内。
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
 * 列出预设的**全部**接入方式（含标准 API）
 *
 * 标准 API 由顶层字段合成，id 固定为 `standard`，永远排第一——UI 的下拉列表直接用它，
 * 不需要另立一张表。没有额外接入方式时返回单元素数组。
 *
 * @param preset - 预设条目
 * @returns 接入方式清单（只读；第一项恒为标准 API）
 */
export function listProviderAccessModes(preset: ProviderPreset): readonly ProviderAccessMode[] {
  const standard: ProviderAccessMode = {
    id: 'standard',
    label: '标准 API（按量计费）',
    labels: { en: 'Standard API (pay-as-you-go)' },
    api: preset.api,
    baseUrl: preset.baseUrl,
    apiKeyEnvHint: preset.apiKeyEnvHint,
    ...(preset.keyHints ? { keyHints: preset.keyHints } : {}),
    ...(preset.docsUrl ? { docsUrl: preset.docsUrl } : {}),
  };
  return [standard, ...(preset.modes ?? [])];
}

/**
 * 按接入方式 id 取一条（缺省 `standard`）
 *
 * @param presetId - 预设 id
 * @param modeId - 接入方式 id（缺省 `standard`）
 * @returns 接入方式；未知 presetId 返回 undefined
 * @throws 未知 modeId 抛错（fail-loud：静默回落标准 API 会让用户以为切到了订阅端点）
 */
export function getProviderAccessMode(
  presetId: string,
  modeId = 'standard',
): ProviderAccessMode | undefined {
  const preset = getProviderPreset(presetId);
  if (!preset) return undefined;
  const mode = listProviderAccessModes(preset).find((m) => m.id === modeId);
  if (!mode) {
    throw new Error(`unknown access mode for preset ${presetId}: ${modeId}`);
  }
  return mode;
}

/**
 * 把「预设 + 接入方式」解析成一组生效值（未给字段回落标准 API）
 *
 * 单一实现点：`expandProviderPreset` 与 UI/向导的展示都走这里，
 * 避免「有的地方回落、有的地方不回落」的第二套规则。
 *
 * @param preset - 预设条目
 * @param modeId - 接入方式 id（缺省 `standard`）
 * @returns 生效的 api / baseUrl / apiKeyEnvHint / keyHints / docsUrl / models
 * @throws 未知 modeId 抛错
 */
export function resolvePresetMode(
  preset: ProviderPreset,
  modeId = 'standard',
): {
  mode: ProviderAccessMode;
  api: ProviderPreset['api'];
  baseUrl: string;
  apiKeyEnvHint: string;
  keyHints?: import('./i18n.js').LocalizedText;
  docsUrl?: string;
  models: ModelPresetModel[];
} {
  const modes = listProviderAccessModes(preset);
  const mode = modes.find((m) => m.id === modeId);
  if (!mode) throw new Error(`unknown access mode for preset ${preset.id}: ${modeId}`);
  return {
    mode,
    api: mode.api,
    baseUrl: mode.baseUrl,
    apiKeyEnvHint: mode.apiKeyEnvHint ?? preset.apiKeyEnvHint,
    ...(mode.keyHints ?? preset.keyHints ? { keyHints: mode.keyHints ?? preset.keyHints } : {}),
    ...(mode.docsUrl ?? preset.docsUrl ? { docsUrl: mode.docsUrl ?? preset.docsUrl } : {}),
    models: mode.models ?? preset.models,
  };
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
 * @param options - 生成器选项；`modeId` 选接入方式（缺省 `standard`，见 {@link resolvePresetMode}）
 * @returns 可写入 octopi.json 的 provider 配置片段
 * @throws 未知 presetId / modeId 时抛错（fail-loud，不做静默空对象）
 */
export function expandProviderPreset(
  presetId: string,
  overrides?: Partial<import('../config.js').ModelProviderConfig>,
  options?: { modeId?: string },
): import('../config.js').ModelProviderConfig {
  const preset = getProviderPreset(presetId);
  if (!preset) {
    throw new Error(`unknown model preset: ${presetId}`);
  }
  const resolved = resolvePresetMode(preset, options?.modeId);
  const apiKeyDefault = resolved.apiKeyEnvHint ? `\${${resolved.apiKeyEnvHint}}` : '';
  return {
    baseUrl: resolved.baseUrl,
    apiKey: apiKeyDefault,
    api: resolved.api,
    models: preset.custom ? [] : resolved.models.map((m) => ({ ...m })),
    ...overrides,
  };
}
