/**
 * Onboarding 向导核心 — 单源状态机 / 双语文案表 / 配置组装（纯逻辑无 IO）。
 *
 * CLI 与 Web 向导共享本模块（product-onboarding.md §1）：渲染器只做呈现，
 * 步骤序、校验、落盘内容都在这里。生成器语义：产出与手写 octopi.json 同构。
 *
 * @module
 */

import { expandProviderPreset, getProviderPreset, listProviderPresets } from './model-presets.js';
import type { ProductLang, LocalizedText } from './i18n.js';
import { pickLocalized } from './i18n.js';

/** 向导步骤 id（product-onboarding.md §3 九步） */
export type OnboardingStepId =
  | 'welcome'
  | 'init-mode'
  | 'deployment-mode'
  | 'provider'
  | 'api-key'
  | 'model'
  | 'probe'
  | 'services'
  | 'first-chat';

/** 步骤序（`init-mode` 仅在 Web 向导可用时呈现——CLI 先行期只有命令行一条道） */
export const ONBOARDING_STEPS: readonly OnboardingStepId[] = [
  'welcome',
  'init-mode',
  'deployment-mode',
  'provider',
  'api-key',
  'model',
  'probe',
  'services',
  'first-chat',
];

/** 初始化方式 */
export type InitMode = 'cli' | 'web';

/** 部署模式（§4） */
export type DeploymentMode = 'personal' | 'organization' | 'multi-organization';

/** 部署模式三选的产品描述 */
export interface DeploymentModeChoice {
  id: DeploymentMode;
  labels: LocalizedText;
  descriptions: LocalizedText;
}

/** 部署模式选项（顺序即展示序） */
export const DEPLOYMENT_MODES: readonly DeploymentModeChoice[] = [
  {
    id: 'personal',
    labels: { zh: '个人使用', en: 'Personal' },
    descriptions: {
      zh: '单人使用这台机器上的助手，无需账号密码。',
      en: 'Just you on this machine — no login required.',
    },
  },
  {
    id: 'organization',
    labels: { zh: '单组织多用户', en: 'Organization' },
    descriptions: {
      zh: '一个组织（团队/公司）内多人使用。组织内可共享知识库、跨用户 agent 协同。',
      en: 'One organization with multiple users. Shared knowledge base and cross-user agent collaboration inside the org.',
    },
  },
  {
    id: 'multi-organization',
    labels: { zh: '多组织多租户', en: 'Multi-organization' },
    descriptions: {
      zh: '多个组织共用一套部署，相互隔离。组织内可共享知识库、跨用户 agent 协同。',
      en: 'Multiple isolated organizations on one deployment. Shared knowledge and collaboration inside each org.',
    },
  },
];

/** 向导收集的选择（渲染器逐步填充） */
export interface OnboardingChoices {
  lang: ProductLang;
  initMode: InitMode;
  deploymentMode: DeploymentMode;
  /** 模式②③的 admin 密码（明文仅存于内存，落盘即 scrypt，不进配置） */
  adminPassword?: string;
  /** 模式③的首个组织名（tenant 名） */
  orgName?: string;
  providerId: string;
  /** 表单覆盖（baseUrl 等；apiKey 单独走 apiKey 字段） */
  providerOverrides?: Record<string, unknown>;
  /** LLM key 明文（写 .env 用，不进 octopi.json） */
  apiKey?: string;
  modelId: string;
}

/** 向导产出：配置片段 + .env 行 + 服务动作提示（渲染器负责执行落盘） */
export interface OnboardingOutput {
  /** 合入 octopi.json 的片段（与手写配置同构） */
  configFragment: {
    language: ProductLang;
    deploymentMode: DeploymentMode;
    providers: Record<string, unknown>;
    /** 模型档位接线（B3）：三档都指向所选 provider/model（merge 时与既有 level 合并） */
    levels: Record<string, { primary: string }>;
    /** default agent 应指向的 model 引用（`<provider>/<model>`；merge 时改写 agents） */
    agentModel: string;
  };
  /** 写入 OCTOPI_HOME/.env 的行（KEY=VALUE；空 = 无需 key） */
  envLines: string[];
}

/**
 * 取当前语言的双语文案（与 pickLocalized 同源，保留本名给向导渲染器）
 *
 * @param map - 双语映射
 * @param fallback - 回落文案
 * @param lang - 当前语言
 * @returns 本地化文案
 */
export function pickLang(map: LocalizedText, fallback: string, lang: ProductLang): string {
  return pickLocalized(map, map[lang]?.trim() || fallback, lang);
}

/**
 * 预设的 apiKey 环境变量名（.env 键 + `${VAR}` 占位同名）
 *
 * @param providerId - 预设 id
 * @returns 环境变量名；无需 key 的预设（ollama 等）返回 ''
 * @throws 未知 providerId（fail-loud）
 */
export function apiKeyEnvVar(providerId: string): string {
  const preset = getProviderPreset(providerId);
  if (!preset) throw new Error(`unknown provider preset: ${providerId}`);
  return preset.apiKeyEnvHint || '';
}

/**
 * 校验一步的选择是否完整（渲染器在「下一步」前调用）
 *
 * @param step - 步骤 id
 * @param choices - 当前选择
 * @returns 错误文案（当前语言）；'' 表示通过
 */
export function validateStep(step: OnboardingStepId, choices: OnboardingChoices): string {
  const zh = choices.lang === 'zh';
  switch (step) {
    case 'welcome':
      return choices.lang ? '' : zh ? '请选择语言' : 'Pick a language';
    case 'init-mode':
      return choices.initMode ? '' : zh ? '请选择初始化方式' : 'Pick an init mode';
    case 'deployment-mode':
      return choices.deploymentMode ? '' : zh ? '请选择部署模式' : 'Pick a deployment mode';
    case 'provider': {
      if (!getProviderPreset(choices.providerId)) return zh ? '请选择一个模型服务' : 'Pick a model provider';
      // custom（OpenAI 兼容）必须给 baseUrl（schema: min(1)；空值产出非法配置）
      if (choices.providerId === 'custom' && !String(choices.providerOverrides?.baseUrl ?? '').trim()) {
        return zh ? '请填写服务的 Base URL（OpenAI 兼容接口地址）' : 'Enter the service base URL (OpenAI-compatible endpoint)';
      }
      return '';
    }
    case 'api-key': {
      const envVar = apiKeyEnvVar(choices.providerId);
      if (!envVar) return ''; // 无需 key 的预设跳过
      return choices.apiKey?.trim()
        ? ''
        : zh
          ? '请粘贴 API Key（或返回上一步换无需 key 的本地模型）'
          : 'Paste your API key (or go back and pick a keyless local model)';
    }
    case 'model':
      return choices.modelId?.trim() ? '' : zh ? '请选择或填写模型名' : 'Pick or type a model id';
    case 'probe':
    case 'services':
    case 'first-chat':
      return ''; // 动作步无输入
  }
}

/**
 * 组装落盘内容（生成器语义：与手写 octopi.json 完全同构）
 *
 * @param choices - 完整选择（须先过 validateStep 全链）
 * @returns 配置片段 + .env 行
 * @throws provider 未知或 apiKey 缺失时抛错（fail-loud，不产半截配置）
 */
export function assembleOnboarding(choices: OnboardingChoices): OnboardingOutput {
  const preset = getProviderPreset(choices.providerId);
  if (!preset) throw new Error(`unknown provider preset: ${choices.providerId}`);

  const envVar = apiKeyEnvVar(choices.providerId);
  if (envVar && !choices.apiKey?.trim()) {
    // fail-loud，不产「KEY=」空值配置（运行时静默 401 比向导报错难查得多）
    throw new Error(`missing api key for provider preset: ${choices.providerId}`);
  }
  const baseUrl = String(choices.providerOverrides?.baseUrl ?? '').trim();
  if (choices.providerId === 'custom' && !baseUrl) {
    throw new Error('missing baseUrl for custom provider');
  }
  const providerConfig = expandProviderPreset(choices.providerId, {
    ...(choices.providerOverrides ?? {}),
    ...(envVar ? { apiKey: `\${${envVar}}` } : {}),
    models: [{ id: choices.modelId.trim() }],
  } as Parameters<typeof expandProviderPreset>[1]);

  const modelRef = `${preset.id}/${choices.modelId.trim()}`;
  return {
    configFragment: {
      language: choices.lang,
      deploymentMode: choices.deploymentMode,
      providers: { [preset.id]: providerConfig },
      // B3：档位与 default agent 全部接线到所选 provider/model（不然「第一句话」仍跑在 openai 写死档上）
      levels: {
        mini: { primary: modelRef },
        standard: { primary: modelRef },
        pro: { primary: modelRef },
      },
      agentModel: modelRef,
    },
    envLines: envVar ? [`${envVar}=${(choices.apiKey ?? '').trim()}`] : [],
  };
}

/**
 * 列出可选 provider 预设（渲染器用）
 *
 * @returns 预设清单（只读）
 */
export function providerChoices(): readonly import('./model-presets.js').ProviderPreset[] {
  return listProviderPresets();
}
