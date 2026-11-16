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
import { rmSync, writeFileSync } from 'node:fs';
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
  };
  notice?: 'back-at-first';
  /** probe 失败：分类码 + 原始信息（人话映射在渲染层单源——webui error-classify / CLI 四选） */
  probeError?: { kind: 'auth' | 'network' | 'model' | 'server'; message: string };
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
  } | null = null;

  constructor(deps: OnboardingServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.randomToken = deps.randomToken ?? (() => randomBytes(24).toString('base64url'));
  }

  /**
   * serve 启动时调用：生成 setup token，返回终端打印用的 URL path（§7：只打印终端）。
   *
   * @returns `/?setup=<token>`；同一实例重复调用返回同一 token（幂等到过期）
   */
  issueSetupToken(): string {
    const active = this.setupToken && this.now() < this.setupToken.expiresAt ? this.setupToken : null;
    if (active) return `/?setup=${active.token}`;
    const token = this.randomToken();
    this.setupToken = { token, expiresAt: this.now() + SETUP_TOKEN_TTL_MS };
    // 落盘（0600）：`octopi init --web` 读它拼浏览器 URL；写失败不挡签发（终端打印是主渠道）
    try {
      writeFileSync(
        join(this.deps.octopiHome, 'setup-token.json'),
        JSON.stringify({ token, expiresAt: this.setupToken.expiresAt }),
        { mode: 0o600 },
      );
    } catch {
      // 磁盘不可写时向导仍可用（终端链接 + loopback 免闸），文件只是 init --web 便利
    }
    return `/?setup=${token}`;
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
   * §7 闸：loopback 免 token（本机已有 shell）；远程必须携带有效未过期 token。
   *
   * @param setupToken - 请求携带的 token（query 或 X-Setup-Token）
   * @param isLoopback - 请求来源是否本机回环
   * @returns 是否放行
   */
  authorize(setupToken: string | undefined, isLoopback: boolean): boolean {
    if (isLoopback) return true;
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

  start(): OnboardingRender {
    if (this.closed) throw new OnboardingStepInvalidError('wizard_closed: 配置已完成，向导不再开放');
    // M-3：幂等——已有会话直接返回现状（StrictMode 双跑/并发 POST 不顶掉正在填的会话）
    if (this.session) return this.render();
    this.session = {
      state: initialOnboardingState(),
      choices: { lang: 'zh', initMode: 'cli', deploymentMode: 'personal', providerId: '', modelId: '' } as OnboardingChoices,
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
    if (stepData) s.choices = mergeOnboardingChoices(s.choices, stepData);
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
      },
      notice: s.notice,
      probeError: s.probeError,
      options,
      stepIndex,
      stepCount,
    };
  }
}
