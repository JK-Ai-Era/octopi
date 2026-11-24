/**
 * Onboarding 向导核心 — 单源状态机 / 双语文案表 / 配置组装（纯逻辑无 IO）。
 *
 * CLI 与 Web 向导共享本模块（product-onboarding.md §1）：渲染器只做呈现，
 * 步骤序、校验、落盘内容都在这里。生成器语义：产出与手写 octopi.json 同构。
 *
 * @module
 */

import {
  expandProviderPreset,
  getProviderPreset,
  listProviderPresets,
  resolvePresetMode,
} from './model-presets.js';
import { MIN_ADMIN_PASSWORD_LENGTH, checkAdminPassword } from './password-policy.js';
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
  /**
   * 接入方式 id（缺省 `standard` = 标准按量计费 API）。
   * 订阅制端点（token-plan / coding-plan / agent-plan）靠它切换 baseUrl 与协议。
   */
  accessModeId?: string;
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
export function apiKeyEnvVar(providerId: string, accessModeId?: string): string {
  const preset = getProviderPreset(providerId);
  if (!preset) throw new Error(`unknown provider preset: ${providerId}`);
  return resolvePresetMode(preset, accessModeId).apiKeyEnvHint || '';
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
    case 'deployment-mode': {
      const mode = choices.deploymentMode as string;
      if (!mode) return zh ? '请选择部署模式' : 'Pick a deployment mode';
      // M-4：③模式组织名必填（此前 Web 端漏校验 → seedDeploymentRegistry 退化 'default' 租户）
      if (mode === 'multi-organization' && !String(choices.orgName ?? '').trim()) {
        return zh ? '请填写组织名称' : 'Enter an organization name';
      }
      // ②③模式 admin 密码必填——必须**在本步**拦住。此前只在落盘前（onboarding-apply）校验，
      // 于是用户能带着「组织模式但无密码」的无效状态一路走到第 7 步测通才被打断，
      // 且中途无任何提示（真机复现）。规则单源在 password-policy（长度与文案同一常量）。
      if (mode !== 'personal') {
        const bad = checkAdminPassword(choices.adminPassword);
        if (bad === 'required') {
          return zh ? '②③ 部署模式需要设置 admin 密码' : 'The org deployment modes require an admin password';
        }
        if (bad === 'too_short') {
          return zh
            ? `admin 密码至少 ${MIN_ADMIN_PASSWORD_LENGTH} 位`
            : `The admin password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`;
        }
      }
      return '';
    }
    case 'provider': {
      if (!getProviderPreset(choices.providerId)) return zh ? '请选择一个模型服务' : 'Pick a model provider';
      // 接入方式必须对该 provider 真实存在：未知 id 会让落盘时静默回落标准端点，
      // 用户以为切到了订阅网关却按标准额度计费——这里显式拦住。
      if (choices.accessModeId !== undefined) {
        try {
          resolvePresetMode(getProviderPreset(choices.providerId)!, choices.accessModeId);
        } catch {
          return zh ? '所选接入方式不可用，请重新选择' : 'That access mode is not available; pick another';
        }
      }
      // custom（OpenAI 兼容）必须给 baseUrl（schema: min(1)；空值产出非法配置）
      if (choices.providerId === 'custom' && !String(choices.providerOverrides?.baseUrl ?? '').trim()) {
        return zh ? '请填写服务的 Base URL（OpenAI 兼容接口地址）' : 'Enter the service base URL (OpenAI-compatible endpoint)';
      }
      return '';
    }
    case 'api-key': {
      const envVar = apiKeyEnvVar(choices.providerId, choices.accessModeId);
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

  const envVar = apiKeyEnvVar(choices.providerId, choices.accessModeId);
  if (envVar && !choices.apiKey?.trim()) {
    // fail-loud，不产「KEY=」空值配置（运行时静默 401 比向导报错难查得多）
    throw new Error(`missing api key for provider preset: ${choices.providerId}`);
  }
  const baseUrl = String(choices.providerOverrides?.baseUrl ?? '').trim();
  if (choices.providerId === 'custom' && !baseUrl) {
    throw new Error('missing baseUrl for custom provider');
  }
  const modelId = choices.modelId.trim();
  const overrides = (choices.providerOverrides ?? {}) as Partial<import('../config.js').ModelProviderConfig>;
  // 模型目录全量落配置（生成器语义）：预设模型全进目录（参考参数随行），
  // 用户「用哪个模型？」只接线 default agent 与 level 三档；手填清单外 id 追加进目录
  const baseModels =
    Array.isArray(overrides.models) && overrides.models.length > 0
      ? overrides.models
      : resolvePresetMode(preset, choices.accessModeId).models.map((m) => ({ ...m }));
  const models = baseModels.some((m) => m?.id === modelId) ? [...baseModels] : [...baseModels, { id: modelId }];
  const providerConfig = expandProviderPreset(
    choices.providerId,
    {
      ...overrides,
      ...(envVar ? { apiKey: `\${${envVar}}` } : {}),
      models,
    } as Parameters<typeof expandProviderPreset>[1],
    { ...(choices.accessModeId ? { modeId: choices.accessModeId } : {}) },
  );

  const modelRef = `${preset.id}/${modelId}`;
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

/**
 * 步骤数据浅合并（白名单字段；Web/CLI 渲染器共用单源——M2）。
 *
 * @param base - 现有选择
 * @param patch - 本步提交的部分字段（只认 OnboardingChoices 顶层键）
 * @returns 合并后的新对象（不改入参）
 */
const ONBOARDING_CHOICE_FIELDS: ReadonlyArray<keyof OnboardingChoices> = [
  'lang',
  'initMode',
  'deploymentMode',
  'orgName',
  'providerId',
  'accessModeId',
  'providerOverrides',
  'adminPassword',
  'apiKey',
  'modelId',
];

export function mergeOnboardingChoices(
  base: OnboardingChoices,
  patch: Partial<OnboardingChoices>,
  opts: {
    /**
     * 该部署形态是否要求 admin 密码（由调用方按模式 + 是否远程绑定判定）。
     * 缺省 false = 按「不需要密码」清理残留值。
     */
    adminPasswordRequired?: boolean;
  } = {},
): OnboardingChoices {
  const out = { ...base };
  // MINOR-1：白名单合并（只认 OnboardingChoices 顶层字段；HTTP 层透传对象不能塞任意键）
  for (const key of ONBOARDING_CHOICE_FIELDS) {
    const v = patch[key];
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  // provider 变更 → 清掉旧 provider 的 modelId：它是「provider 下的模型」，换了 provider 就不再
  // 成立。不清会把手填脏值带进新 provider（真机复现：openai 的模型名被写进 deepseek 配置，
  // 到第 7 步测通才失败）。调用方若同时显式给了 modelId（如回退后原 provider 重选），以显式值为准。
  if (patch.providerId !== undefined && patch.providerId !== base.providerId && patch.modelId === undefined) {
    out.modelId = ''; // 非可选字段：空串即「未选模型」，由 model 步校验拦住
  }
  // 不需要密码的形态不接受 adminPassword/orgName：卡片文案承诺「无需账号密码」，
  // 残留值会在落盘时给 default 用户设密码（静默与承诺相反）。
  // 需要密码时（②③，或「个人 + 远程绑定」）**不能清**——否则用户刚输的密码被抹掉。
  if (!opts.adminPasswordRequired) {
    out.adminPassword = undefined;
    out.orgName = out.deploymentMode === 'personal' ? undefined : out.orgName;
  }
  return out;
}

// ── 状态机（M2 抽取）：步骤图转移为纯函数，CLI/Web 渲染器共享同一真相 ──

/** 向导状态机状态（渲染器逐步推进；纯数据可序列化——Web 侧可跨请求存放） */
export interface OnboardingMachineState {
  /** 当前步骤；null = 结束（completed / aborted / exit） */
  current: OnboardingStepId | null;
  /** 回退栈（已走过的步骤） */
  stack: OnboardingStepId[];
  /** 正常走完全部步骤 */
  completed: boolean;
  /** EOF/输入断流而中止（半截状态不组装——批 1 EOF 尾巴） */
  aborted: boolean;
  /** 用户选择「保存并退出」（m5：文案=行为） */
  exitSave: boolean;
}

/** 状态机事件（渲染器把用户动作翻译成事件） */
export type OnboardingEvent =
  | { kind: 'next' }
  | { kind: 'back' }
  | { kind: 'goto'; step: OnboardingStepId }
  | { kind: 'exit'; save: boolean }
  | { kind: 'eof' };

/**
 * commit 时机标记（渲染器据此调 applyOnboarding）：
 * - `after-probe`：测通通过、services 动作之前（B2——spawn 出的进程读盘才拿得到新配置）
 * - `on-exit-save`：用户选「保存并退出」（m5）
 * - `on-done`：正常走完（防御落盘，仅限完整状态）
 */
export type OnboardingCommit = 'none' | 'after-probe' | 'on-exit-save' | 'on-done';

/** 转移结果 */
export interface OnboardingTransition {
  state: OnboardingMachineState;
  commit: OnboardingCommit;
  /** 提示类反馈（渲染器本地化呈现） */
  notice?: 'back-at-first';
}

/**
 * 初始状态
 *
 * @param start - 起始步骤（默认 welcome）
 * @returns 全新状态机状态
 */
export function initialOnboardingState(start: OnboardingStepId = 'welcome'): OnboardingMachineState {
  return { current: start, stack: [], completed: false, aborted: false, exitSave: false };
}

/**
 * 纯转移函数（M2 核心）：无 IO、无渲染，Web/CLI 唯一步骤图真相。
 *
 * @param state - 当前状态
 * @param event - 事件
 * @returns 转移后状态 + commit 时机
 */
export function nextStep(state: OnboardingMachineState, event: OnboardingEvent): OnboardingTransition {
  if (state.current === null) return { state, commit: 'none' }; // 终态吸收
  const idx = ONBOARDING_STEPS.indexOf(state.current);
  switch (event.kind) {
    case 'next': {
      const nextIdx = idx + 1;
      const done = nextIdx >= ONBOARDING_STEPS.length;
      return {
        state: {
          ...state,
          current: done ? null : ONBOARDING_STEPS[nextIdx],
          stack: [...state.stack, state.current],
          completed: done,
        },
        // B2：测通通过即落盘（services 动作读盘拿新配置）；走完防御落盘（半截状态不组装）
        commit: state.current === 'probe' ? 'after-probe' : done ? 'on-done' : 'none',
      };
    }
    case 'back': {
      const prev = state.stack[state.stack.length - 1];
      if (prev === undefined) return { state, commit: 'none', notice: 'back-at-first' }; // m13：空栈回退给提示，不静默绕圈
      return { state: { ...state, current: prev, stack: state.stack.slice(0, -1) }, commit: 'none' };
    }
    case 'goto': {
      // M1：探针失败动作面的精确落点（rekey→api-key / reprovider→provider）；非法目标忽略（fail-safe 不坏状态）
      if (!ONBOARDING_STEPS.includes(event.step)) {
        return { state, commit: 'none' };
      }
      // 自身不压栈（否则重试循环把「上一步」变成原地踏步 + 栈无限增长）
      const stack = event.step === state.current ? state.stack : [...state.stack, state.current];
      return { state: { ...state, current: event.step, stack }, commit: 'none' };
    }
    case 'exit': {
      // m5：save=true 落盘退出；save=false 半截状态不组装
      return {
        state: { ...state, current: null, exitSave: event.save },
        commit: event.save ? 'on-exit-save' : 'none',
      };
    }
    case 'eof': {
      return { state: { ...state, current: null, aborted: true }, commit: 'none' };
    }
  }
}
