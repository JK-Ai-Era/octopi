/**
 * Web 向导服务端（§1 双向导单源 / §7 setup token）。
 *
 * 分工：状态机推进（engine `nextStep`）+ 步骤校验（engine `validateStep`）+ 落盘播种
 * （engine `applyOnboarding`）全部在服务端；webui 只渲染 `OnboardingRender` 并回传事件——
 * 两端共享同一份步骤图真相（M2：不复制第二套）。
 *
 * setup token（§7 拍板）：Web 向导启动时生成一次性 token，只打印在终端
 * （`http://<host>:8180/?setup=<token>`），向导接口校验；完成或 30 分钟超时即失效。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { rmSync } from 'node:fs';
import { writeSecretFileSync } from '@octopi-agent/engine/file-mode.js';
import { join } from 'node:path';
import {
  DEPLOYMENT_MODES,
  mergeOnboardingChoices,
  nextStep,
  initialOnboardingState,
  ONBOARDING_STEPS,
  providerChoices,
  validateStep,
  type OnboardingChoices,
  type OnboardingEvent,
  type OnboardingMachineState,
  type OnboardingStepId,
} from '@octopi-agent/engine/config-admin/onboarding.js';
import { pickLocalized } from '@octopi-agent/engine/config-admin/i18n.js';
import { getProviderPreset } from '@octopi-agent/engine/config-admin/model-presets.js';
import { requiresAdminPassword } from '@octopi-agent/engine/config-admin/onboarding-apply.js';
import {
  readConsoleAccessKey,
  type ConsoleAccessKey,
} from '@octopi-agent/engine/config-admin/console-access-key.js';
import type { ProbeErrorKind } from '@octopi-agent/engine/config-admin/error-copy.js';
import {
  applyOnboarding,
  classifyProbeError,
  probeProvider,
} from '@octopi-agent/engine/config-admin/onboarding-apply.js';

/** 向导渲染描述（webui 据此画当前步骤的表单） */
export interface OnboardingRender {
  step: OnboardingStepId | null;
  completed: boolean;
  aborted: boolean;
  /** 已填数据（脱敏：apiKey/adminPassword 只回传是否已填，绝不回显明文） */
  choices: {
    lang?: string;
    initMode?: string;
    deploymentMode?: string;
    orgName?: string;
    providerId?: string;
    modelId?: string;
    hasApiKey?: boolean;
    hasAdminPassword?: boolean;
    /**
     * 该部署形态是否要求 admin 密码（②③模式恒 true；个人模式仅远程绑定时 true）。
     * UI 据此决定是否显示密码框——只按「模式」判断会让个人+远程绑定用户无从输密码。
     */
    adminPasswordRequired?: boolean;
  };
  notice?: 'back-at-first';
  /** M-6 热应用结果：true=已即时生效（新会话即用新配置）；false=失败（见 hotApplyError，仍需重启）；undefined=未热应用 */
  hotApplied?: boolean;
  hotApplyError?: string;
  /**
   * 控制台准入密钥（`channels[type=http].apiKey`）——**仅最后一步/完成时给出**。
   *
   * 与 `choices.apiKey` 是两件东西：那是 LLM provider 密钥，永不回显；这是
   * initOctopi 随机生成的控制台准入密钥，用户不复制就只能翻配置文件找。
   * 只在最后一步下发，缩小密钥在浏览器里的暴露窗口（其余步骤不返回）。
   */
  consoleAccessKey?: ConsoleAccessKey;
  /** probe 失败：分类码 + 原始信息（人话映射在渲染层单源——webui/CLI 的 probeErrorCopy） */
  probeError?: { kind: ProbeErrorKind; message: string };
  /** 步骤校验失败（HTTP 400 语义的回显） */
  invalid?: string;
  /** 步骤进度（单源 ONBOARDING_STEPS 派生；webui 不得自维护步骤序） */
  stepIndex: number;
  stepCount: number;
  /** 选项清单（单源在服务端；webui 纯渲染） */
  options: {
    languages: Array<{ id: string; label: string }>;
    deploymentModes: Array<{ id: string; label: string; description: string }>;
    providers: Array<{ id: string; label: string; keyHint: string; api: string; defaultBaseUrl: string }>;
    /** 当前所选 provider 的模型预设（选择器用；允许手填 —— 预设只是候选，不是白名单） */
    models: Array<{ id: string; label: string; contextWindow?: number }>;
  };
}

/** 步骤校验失败（渲染层把 message 回显给用户） */
export class OnboardingStepInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingStepInvalidError';
  }
}

export interface OnboardingServiceDeps {
  configPath: string;
  octopiHome: string;
  /** 整文件 schema 校验（fail-loud；由套件层注入 compose schema） */
  validateConfig: (raw: Record<string, unknown>) => void;
  /** 模式②③ admin 名覆盖（env 注入） */
  adminName?: string;
  /**
   * 落盘后的热应用钩子（M-6：向导产物接 ApplyEngine——daemon 注入
   * `configApply.applyFromDisk`）。抛错不回滚落盘（配置已是真相），
   * 警告随 render 透出；未注入 = 保留「需重启生效」提示。
   */
  onConfigApplied?: () => Promise<void>;
  /** 测试注入 */
  now?: () => number;
  /** 测试注入（默认 crypto 随机 token） */
  randomToken?: () => string;
}

const SETUP_TOKEN_TTL_MS = 30 * 60_000; // §7：30 分钟

/** Web 向导服务端（单会话；会话态在内存，刷新即重来——批 2 已知边界） */
export class OnboardingService {
  private deps: OnboardingServiceDeps;
  private now: () => number;
  private randomToken: () => string;
  private setupToken: { token: string; expiresAt: number } | null = null;
  /** B-3：配置完成后关闭向导面（loopback 也不再放行——写门只在首启开着） */
  private closed = false;
  /** M-3：in-flight 门闩（并发事件不跳步/不并发写盘） */
  private inFlight = false;

  private session: {
    state: OnboardingMachineState;
    choices: OnboardingChoices;
    probeError?: OnboardingRender['probeError'];
    notice?: 'back-at-first';
    /** M-6：热应用结果（true=已即时生效；undefined=未注入钩子/未走到） */
    hotApplied?: boolean;
    hotApplyError?: string;
  } | null = null;

  constructor(deps: OnboardingServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.randomToken = deps.randomToken ?? (() => randomBytes(24).toString('base64url'));
  }

  /**
   * serve 启动时调用：生成 setup token（§7：只打印终端）。
   *
   * @returns token 与 URL path（token 是权威——URL 拼接由 setupWizardUrl 单源负责，评审 m8）
   */
  issueSetupToken(): { token: string; path: string } {
    const active = this.setupToken && this.now() < this.setupToken.expiresAt ? this.setupToken : null;
    if (active) return { token: active.token, path: `/?setup=${active.token}` };
    const token = this.randomToken();
    this.setupToken = { token, expiresAt: this.now() + SETUP_TOKEN_TTL_MS };
    // 落盘（0600）：`octopi init --web` 读它拼浏览器 URL；写失败不挡签发（终端打印是主渠道）
    try {
      // setup token 是秘密：`mode` 在 Windows 上不生效，用真实权限收紧；
      // 收紧失败时 writeSecretFileSync 已删除文件，签发不受影响（终端打印是主渠道）。
      writeSecretFileSync(
        join(this.deps.octopiHome, 'setup-token.json'),
        JSON.stringify({ token, expiresAt: this.setupToken.expiresAt }),
      );
    } catch {
      // 磁盘不可写时向导仍可用（终端链接 + loopback 免闸），文件只是 init --web 便利
    }
    return { token, path: `/?setup=${token}` };
  }

  /** 清除 token（完成/过期/换发统一入口——内存与磁盘一致） */
  private clearSetupToken(): void {
    this.setupToken = null;
    try {
      rmSync(join(this.deps.octopiHome, 'setup-token.json'), { force: true });
    } catch {
      // 残留文件由过期判据兜底（读到过期 token 同样拒）
    }
  }

  /**
   * §7 闸：任何来源都必须携带有效未过期 setup token。
   *
   * 为什么 loopback 不再免闸：豁免面接入 adapter 后，本机 127.0.0.1 成为**可达**面——
   * 同一台机器上任意网页都能 POST 到这里驱动向导改写 octopi.json / .env。
   * 「本机已有 shell 所以免闸」在写配置的面上不成立：浏览器不是 shell，它没有用户的
   * 意图。浏览器侧本来就带着 URL 里的 `?setup=`（OnboardingWizard 单源），因此去掉免闸
   * 不影响正常旅程，只挡掉跨站写入。
   *
   * @param setupToken - 请求携带的 token（query 或 X-Setup-Token）
   * @returns 是否放行
   */
  authorize(setupToken: string | undefined): boolean {
    const t = this.setupToken;
    if (!t) return false;
    if (this.now() > t.expiresAt) {
      this.clearSetupToken(); // 过期即清（§7：30 分钟超时失效）
      return false;
    }
    if (!setupToken) return false;
    const a = Buffer.from(t.token);
    const b = Buffer.from(setupToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** 向导是否仍可开始（token 未因完成/超时失效） */
  isAvailable(): boolean {
    return this.setupToken !== null && this.now() < this.setupToken.expiresAt && this.session === null;
  }

  /**
   * 创建向导会话（HTTP 面：loopback 免闸；远程由路由层先 authorize）。
   *
   * @returns 当前步骤渲染
   */
  /** 标记向导已不可用（daemon 在 config 已含 deploymentMode 时调用） */
  closeWizard(): void {
    this.closed = true;
    this.clearSetupToken();
  }

  /**
   * 开会话（幂等：已有会话原样返回，StrictMode 双跑/并发 POST 不顶掉正在填的会话）。
   *
   * @param initialLang - 首个 render 的本地化基准语言（客户端界面偏好）。缺省 'zh'；
   *                      只在**新建**会话时生效，已有会话不因后续请求被改写。
   * @returns 当前渲染
   * @throws OnboardingStepInvalidError 向导已关闭
   */
  start(initialLang: 'zh' | 'en' = 'zh'): OnboardingRender {
    if (this.closed) throw new OnboardingStepInvalidError('wizard_closed: 配置已完成，向导不再开放');
    // M-3：幂等——已有会话直接返回现状（StrictMode 双跑/并发 POST 不顶掉正在填的会话）
    if (this.session) return this.render();
    this.session = {
      state: initialOnboardingState(),
      choices: {
        lang: initialLang,
        initMode: 'cli',
        deploymentMode: 'personal',
        providerId: '',
        modelId: '',
      } as OnboardingChoices,
      notice: undefined,
    };
    return this.render();
  }

  /**
   * 提交事件 + 本步数据。probe 步的 next 先跑服务端探针（成功才前进）。
   *
   * @param event - 状态机事件（next/back/goto/exit）
   * @param stepData - 本步表单数据（部分字段，白名单合并）
   * @returns 推进后的渲染
   * @throws OnboardingStepInvalidError 步骤校验失败
   */
  async submit(event: OnboardingEvent, stepData?: Partial<OnboardingChoices>): Promise<OnboardingRender> {
    if (this.inFlight) throw new OnboardingStepInvalidError('wizard_busy: 上一步还在处理，请稍候');
    this.inFlight = true;
    try {
      return await this.submitInner(event, stepData);
    } finally {
      this.inFlight = false;
    }
  }

  private async submitInner(event: OnboardingEvent, stepData?: Partial<OnboardingChoices>): Promise<OnboardingRender> {
    const s = this.session;
    if (!s) throw new Error('onboarding_no_session: 向导会话不存在或已结束');
    if (stepData) {
      // 「是否需要密码」按**合并后**的模式 + 远程绑定判定：切到 personal 且本机部署才清残留密码；
      // 个人 + 远程绑定（或②③）必须保留用户刚输入的密码。
      const nextMode = stepData.deploymentMode ?? s.choices.deploymentMode;
      s.choices = mergeOnboardingChoices(s.choices, stepData, {
        adminPasswordRequired: requiresAdminPassword(nextMode, this.deps.configPath),
      });
    }
    s.notice = undefined;

    if (event.kind === 'next' && s.state.current !== null) {
      const invalid = validateStep(s.state.current, s.choices);
      if (invalid) throw new OnboardingStepInvalidError(invalid);
      // probe 步：服务端探针（key 只在服务端展开）成功才前进；失败给操作面、状态不动
      if (s.state.current === 'probe') {
        try {
          await probeProvider(s.choices);
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          s.probeError = { kind: classifyProbeError(err), message: err.message };
          return this.render();
        }
      }
    }

    s.probeError = undefined;
    const t = nextStep(s.state, event);
    s.state = t.state;
    if (t.notice) s.notice = t.notice;

    // commit 时机（状态机语义）：测通后 / 保存退出 / 走完——半截状态不组装
    if (t.commit !== 'none') {
      await applyOnboarding(s.choices, {
        configPath: this.deps.configPath,
        octopiHome: this.deps.octopiHome,
        adminName: this.deps.adminName,
        validateConfig: this.deps.validateConfig,
      });
      // M-6：落盘后热应用（同一 ApplyEngine 通路）。抛错不回滚落盘（配置已是真相），
      // 以 hotApplyError 透出——完成页降级提示重启（fail-loud 的显式降级）。
      if (this.deps.onConfigApplied) {
        try {
          await this.deps.onConfigApplied();
          s.hotApplied = true;
          s.hotApplyError = undefined;
        } catch (err) {
          s.hotApplied = false;
          s.hotApplyError = err instanceof Error ? err.message : String(err);
        }
      }
      // §7：完成/保存退出才一次性失效；after-probe 落盘后向导还要走完（远程中途断线=断）
      if (t.commit === 'on-done' || t.commit === 'on-exit-save') this.clearSetupToken();
    }
    return this.render();
  }

  /** 当前渲染（无会话时 step=null；options 恒给——选项单源在服务端） */
  render(): OnboardingRender {
    const lang = this.session?.choices.lang ?? 'zh';
    const options = {
      languages: [
        { id: 'zh', label: '中文' },
        { id: 'en', label: 'English' },
      ],
      deploymentModes: DEPLOYMENT_MODES.map((m) => ({
        id: m.id,
        label: pickLocalized(m.labels, m.id, lang),
        description: pickLocalized(m.descriptions, '', lang),
      })),
      providers: providerChoices().map((pr) => ({
        id: pr.id,
        label: pickLocalized(pr.labels, pr.label, lang),
        keyHint: pickLocalized(pr.keyHints, pr.apiKeyEnvHint, lang),
        api: pr.api,
        defaultBaseUrl: pr.baseUrl,
      })),
      // 模型预设跟随「当前所选 provider」（会话已选 → 草稿尚未落盘的 provider 也覆盖不到，
      // 故用已保存值；provider 一旦提交就会刷新）。手填仍允许：预设只是候选。
      models: (() => {
        const id = this.session?.choices.providerId;
        const preset = id ? getProviderPreset(id) : undefined;
        // 预设模型只有 id/name（无多语言 label 字段）——直接用 name，不做不存在的 labels 查询。
        return (preset?.models ?? []).map((m) => ({
          id: m.id,
          label: m.name ?? m.id,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        }));
      })(),
    };
    const s = this.session;
    const stepCount = ONBOARDING_STEPS.length;
    const stepIndex = s?.state.current ? ONBOARDING_STEPS.indexOf(s.state.current) + 1 : 0;
    if (!s) return { step: null, completed: false, aborted: false, choices: {}, options, stepIndex, stepCount };
    return {
      step: s.state.current,
      completed: s.state.completed,
      aborted: s.state.aborted,
      choices: {
        lang: s.choices.lang,
        initMode: s.choices.initMode,
        deploymentMode: s.choices.deploymentMode,
        orgName: s.choices.orgName,
        providerId: s.choices.providerId,
        modelId: s.choices.modelId,
        hasApiKey: Boolean(s.choices.apiKey),
        hasAdminPassword: Boolean(s.choices.adminPassword),
        adminPasswordRequired: requiresAdminPassword(s.choices.deploymentMode, this.deps.configPath),
      },
      notice: s.notice,
      probeError: s.probeError,
      hotApplied: s.hotApplied,
      hotApplyError: s.hotApplyError?.split(this.deps.octopiHome).join('~'), // NIT：本地路径打码再出浏览器
      // 控制台准入密钥只在「收尾」三个时机下发：最后一步（first-chat）、正常走完、
      // 保存并退出。此时配置已/即将落盘（probe 步 commit=after-probe），密钥是最终值；
      // 其余步骤不返回，缩小密钥在浏览器里的暴露窗口。
      ...((s.state.current === 'first-chat' || s.state.completed || s.state.exitSave)
        ? { consoleAccessKey: readConsoleAccessKey(this.deps.configPath) }
        : {}),
      options,
      stepIndex,
      stepCount,
    };
  }
}
