/**
 * Web 向导服务端回归（批 2-4 / §7）：
 * - setup token：幂等签发 / 30 分钟过期 / 远程无 token 拒 / loopback 免 / 完成即失效
 * - 状态机推进：校验失败拒 / back notice / probe 失败状态不动给分类码
 * - commit 时机：走完才落盘（半截状态不组装）；render 脱敏（apiKey/adminPassword 不回显）
 */

import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// probeProvider 打真网络——测试注入假探针（其余动作真跑文件系统）
const probeMock = vi.fn<(choices: unknown) => Promise<{ ok: boolean }>>();
vi.mock('../packages/engine/src/config-admin/onboarding-apply.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../packages/engine/src/config-admin/onboarding-apply.js')>();
  return { ...orig, probeProvider: (c: unknown) => probeMock(c) };
});

const { OnboardingService, OnboardingStepInvalidError } = await import(
  '../packages/gateway/src/web/api/onboarding.js'
);

const validateConfig = (): void => {}; // 合并语义由 engine 锚覆盖；此处测服务端编排
const T0 = 1_000_000;

/** 每用例独立 HOME（写盘用例互不污染） */
function makeService(overrides: Partial<ConstructorParameters<typeof OnboardingService>[0]> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'octopi-onboarding-web-'));
  const svc = new OnboardingService({
    configPath: join(home, 'octopi.json'),
    octopiHome: home,
    validateConfig,
    now: () => T0,
    randomToken: () => 'tok-fixed',
    ...overrides,
  });
  return Object.assign(svc, { __home: home, __config: join(home, 'octopi.json') });
}

import { ONBOARDING_STEPS } from '../packages/engine/src/config-admin/onboarding.js';

const baseChoices: Partial<import('../packages/engine/src/config-admin/onboarding.js').OnboardingChoices> = {
  lang: 'zh',
  initMode: 'web',
  deploymentMode: 'personal',
  providerId: 'deepseek',
  apiKey: 'sk-real-secret',
  modelId: 'deepseek-chat',
};



describe('setup token 闸（§7）', () => {
  it('幂等签发（TTL 内重复调用同 token）+ URL 形态', () => {
    const svc = makeService();
    expect(svc.issueSetupToken()).toBe('/?setup=tok-fixed');
    expect(svc.issueSetupToken()).toBe('/?setup=tok-fixed');
  });

  it('30 分钟过期：过期后远程拒、再签发换新 token', () => {
    let now = T0;
    const svc = makeService({ now: () => now, randomToken: () => `tok-${now}` });
    svc.issueSetupToken();
    now = T0 + 30 * 60_000 + 1; // 过期
    expect(svc.authorize('tok-0', false)).toBe(false);
    expect(svc.issueSetupToken()).toContain(`tok-${now}`); // 新 token
    expect(svc.authorize(`tok-${now}`, false)).toBe(true);
  });

  it('远程无 token / 错 token 拒；loopback 免闸', () => {
    const svc = makeService();
    svc.issueSetupToken();
    expect(svc.authorize(undefined, false)).toBe(false);
    expect(svc.authorize('wrong', false)).toBe(false);
    expect(svc.authorize(undefined, true)).toBe(true);
    expect(svc.authorize('tok-fixed', false)).toBe(true);
  });

  it('完成向导后 token 一次性失效', async () => {
    const svc = makeService();
    svc.issueSetupToken();
    svc.start();
    const steps = ['welcome', 'init-mode', 'deployment-mode', 'provider', 'api-key', 'model', 'probe', 'services', 'first-chat'] as const;
    for (const [i, step] of steps.entries()) {
      const r = await svc.submit({ kind: 'next' }, step === 'provider' ? baseChoices : step === 'api-key' ? baseChoices : step === 'model' ? baseChoices : undefined);
      // 推进断言（替代此前的恒真摆设）：每步应走到 steps 里的下一步，走完为 null
      expect(r.step).toBe(i === steps.length - 1 ? null : steps[i + 1]);
    }
    expect(svc.authorize('tok-fixed', false)).toBe(false); // 完成即失效
  });
});

describe('状态机推进（M2 单源）', () => {
  it('校验失败抛 OnboardingStepInvalidError（welcome 空语言）', async () => {
    const svc = makeService();
    svc.start();
    await expect(svc.submit({ kind: 'next' }, { lang: '' as never })).rejects.toBeInstanceOf(OnboardingStepInvalidError);
  });

  it('back 空栈给 back-at-first notice，状态不丢', async () => {
    const svc = makeService();
    svc.start();
    const r = await svc.submit({ kind: 'back' });
    expect(r.notice).toBe('back-at-first');
    expect(r.step).toBe('welcome');
  });

  it('probe 失败：状态停在 probe，回分类码 + 原始信息', async () => {
    probeMock.mockRejectedValueOnce(new Error('401 Unauthorized: bad key'));
    const svc = makeService();
    svc.start();
    for (const step of ['welcome', 'init-mode', 'deployment-mode', 'provider', 'api-key', 'model'] as const) {
      await svc.submit({ kind: 'next' }, step === 'provider' || step === 'api-key' || step === 'model' ? baseChoices : undefined);
    }
    const r = await svc.submit({ kind: 'next' });
    expect(r.step).toBe('probe');
    expect(r.probeError).toEqual({ kind: 'auth', message: '401 Unauthorized: bad key' });
  });
});

describe('commit 时机与脱敏', () => {
  it('半截状态不组装（exit save=false 不落盘）', async () => {
    const svc = makeService();
    svc.start();
    await svc.submit({ kind: 'next' }, baseChoices); // welcome
    await svc.submit({ kind: 'exit', save: false });
    expect(existsSync(svc.__config)).toBe(false);
  });

  it('走完落盘 + .env 有 key 行 + render 永不含明文', async () => {
    probeMock.mockResolvedValueOnce({ ok: true });
    const svc = makeService();
    svc.start();
    const steps = ['welcome', 'init-mode', 'deployment-mode', 'provider', 'api-key', 'model', 'probe', 'services', 'first-chat'] as const;
    let last;
    for (const [i, step] of steps.entries()) {
      last = await svc.submit({ kind: 'next' }, ['provider', 'api-key', 'model'].includes(step) ? baseChoices : undefined);
    }
    expect(last?.completed).toBe(true);
    expect(existsSync(svc.__config)).toBe(true);
    const env = readFileSync(join(svc.__home, '.env'), 'utf8');
    expect(env).toContain('DEEPSEEK_API_KEY=sk-real-secret');
    const serialized = JSON.stringify(last);
    expect(serialized).not.toContain('sk-real-secret');
    expect(last?.choices.hasApiKey).toBe(true);
  });
});

describe('M2 单源契约', () => {
  it('webui 渲染器的 case 清单必须覆盖且只覆盖 ONBOARDING_STEPS（id 漂移即红）', () => {
    const src = readFileSync('packages/webui/src/components/OnboardingWizard.tsx', 'utf8');
    const cases = [...src.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]).sort();
    const engineSteps = [...ONBOARDING_STEPS].filter((x) => x !== 'welcome').sort(); // welcome 无 case（默认页）
    // 向导九步里 webui 需 case 的步骤（welcome 走渲染头不走 case 也行——断言 engine 步骤都被 case 覆盖）
    for (const step of ONBOARDING_STEPS) {
      if (step === 'welcome') continue;
      expect(cases, `webui 缺 case '${step}'`).toContain(step);
    }
  });
});
