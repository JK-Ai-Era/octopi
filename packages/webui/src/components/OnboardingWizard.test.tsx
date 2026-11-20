// @vitest-environment jsdom
/**
 * OnboardingWizard — Web 向导交互回归锚（真机报告的三个 bug）。
 *
 * 这些 bug 都是「UI 不给反馈」型，纯服务端测试覆盖不到，因此在此锁住：
 * 1. 部署模式：点第二项必须有选中态，且必须真的把选中项提交上去（不是服务端旧值）。
 * 2. 部署模式非个人时，admin 密码输入框必须随之出现（否则用户无从填写，
 *    会走到第 7 步才被 onboarding_admin_password_required 打断）。
 * 3. 模型步：有预设时必须给出可点选项，且允许切到手填。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { OnboardingWizard } from './OnboardingWizard';

type Render = Record<string, unknown>;

const DEPLOYMENT_MODES = [
  { id: 'personal', label: '个人使用', description: '本机单人' },
  { id: 'organization', label: '单组织多用户', description: '一个组织' },
  { id: 'multi-organization', label: '多组织多租户', description: '多个组织' },
];

/**
 * 构造服务端 render 的最小替身（字段与 OnboardingRender 一致）。
 *
 * @param over - 覆盖项（step / stepIndex / choices / options）
 * @returns render 对象
 */
function makeRender(over: Render = {}): Render {
  return {
    step: 'deployment-mode',
    completed: false,
    aborted: false,
    stepIndex: 3,
    stepCount: 9,
    choices: { lang: 'zh', initMode: 'cli', deploymentMode: 'personal' },
    options: {
      languages: [{ id: 'zh', label: '中文' }],
      deploymentModes: DEPLOYMENT_MODES,
      providers: [
        { id: 'deepseek', label: 'DeepSeek', keyHint: '', api: 'openai-completions', defaultBaseUrl: '' },
      ],
      models: [],
    },
    ...over,
  };
}

/** 每次 /session/event 的请求体（断言「提交了什么」） */
let submitted: Array<{ event: { kind: string }; stepData: Record<string, unknown> }> = [];
/** `/session`（开会话）返回的 render，也是测试的起点 */
let initial: Render = makeRender();
/** `/session/event` 返回的 render（推进后） */
let after: Render = makeRender();

/**
 * 桩掉 fetch：`/session` 返回 initial，`/session/event` 记录请求体并返回 after。
 *
 * @returns 无
 */
function stubFetch(): void {
  submitted = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      const isEvent = String(url).endsWith('/session/event');
      if (isEvent) submitted.push(body);
      return {
        ok: true,
        json: async () => ({ ok: true, data: isEvent ? after : initial }),
      } as unknown as Response;
    }),
  );
}

beforeEach(() => {
  initial = makeRender();
  after = makeRender();
  stubFetch();
  window.history.replaceState({}, '', '/?setup=tok-fixed');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('部署模式步', () => {
  it('点第二项后该项显示为选中（aria-pressed=true），而不是毫无反应', async () => {
    render(<OnboardingWizard onDone={() => {}} />);
    const org = await screen.findByRole('button', { name: /单组织多用户/ });
    expect(org.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(org);
    await waitFor(() => expect(org.getAttribute('aria-pressed')).toBe('true'));
  });

  it('选中组织模式后出现 admin 密码输入框（否则用户不知道要填）', async () => {
    const { container } = render(<OnboardingWizard onDone={() => {}} />);
    await screen.findByRole('button', { name: /单组织多用户/ });
    expect(container.querySelectorAll('input[type="password"]').length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /单组织多用户/ }));
    await waitFor(() => expect(container.querySelectorAll('input[type="password"]').length).toBe(2));
  });

  it('提交的是用户选中的模式（不是服务端旧值 personal），并带上密码', async () => {
    after = makeRender({ step: 'provider' });
    const { container } = render(<OnboardingWizard onDone={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /单组织多用户/ }));
    const pw = container.querySelectorAll('input[type="password"]');
    fireEvent.change(pw[0]!, { target: { value: 'S3cret!pw' } });
    fireEvent.change(pw[1]!, { target: { value: 'S3cret!pw' } });
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    await waitFor(() => expect(submitted.length).toBeGreaterThan(0));
    expect(submitted[0]!.stepData.deploymentMode).toBe('organization');
    expect(submitted[0]!.stepData.adminPassword).toBe('S3cret!pw');
  });

  it('两次密码不一致时拦住，不发请求', async () => {
    const { container } = render(<OnboardingWizard onDone={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /单组织多用户/ }));
    const pw = container.querySelectorAll('input[type="password"]');
    fireEvent.change(pw[0]!, { target: { value: 'aaa' } });
    fireEvent.change(pw[1]!, { target: { value: 'bbb' } });
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    await waitFor(() => expect(screen.getByText(/两次输入的密码不一致/)).toBeTruthy());
    expect(submitted.length).toBe(0);
  });
});

describe('模型步', () => {
  it('有预设时给出可点选项，点击即提交该模型 id', async () => {
    initial = makeRender({
      step: 'model',
      stepIndex: 6,
      choices: { lang: 'zh', initMode: 'cli', deploymentMode: 'personal', providerId: 'deepseek' },
      options: {
        ...(makeRender().options as Record<string, unknown>),
        models: [
          { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', contextWindow: 1050000 },
          { id: 'deepseek-v4-pro', label: 'DeepSeek-V4.1-Pro', contextWindow: 1050000 },
        ],
      },
    });
    after = makeRender({ step: 'probe', stepIndex: 7 });
    stubFetch();
    render(<OnboardingWizard onDone={() => {}} />);
    const flash = await screen.findByRole('button', { name: /DeepSeek-V4\.1-Flash/ });
    fireEvent.click(flash);
    await waitFor(() => expect(submitted.length).toBeGreaterThan(0));
    expect(submitted[0]!.stepData.modelId).toBe('deepseek-flash');
  });

  it('可切到手填模型 id 并真正提交该值（预设有缺失时不被锁死）', async () => {
    initial = makeRender({
      step: 'model',
      stepIndex: 6,
      choices: { lang: 'zh', initMode: 'cli', deploymentMode: 'personal', providerId: 'deepseek' },
      options: {
        ...(makeRender().options as Record<string, unknown>),
        models: [{ id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' }],
      },
    });
    after = makeRender({ step: 'probe', stepIndex: 7 });
    stubFetch();
    render(<OnboardingWizard onDone={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /手动输入模型 id/ }));
    const input = await screen.findByLabelText(/模型 id/);
    fireEvent.change(input, { target: { value: 'my-custom-model' } });
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    await waitFor(() => expect(submitted.length).toBeGreaterThan(0));
    expect(submitted[0]!.stepData.modelId).toBe('my-custom-model');
  });

  it('provider 变更后旧 provider 的模型不被自动锁进"手填"（预设仍可选）', async () => {
    // 服务端在 provider 变化时清空 modelId（merge 原语已保证），因此这里 current 为空、
    // 应当直接展示新 provider 的预设卡片，而不是进入手填模式。
    initial = makeRender({
      step: 'model',
      stepIndex: 6,
      choices: { lang: 'zh', initMode: 'cli', deploymentMode: 'personal', providerId: 'deepseek', modelId: '' },
      options: {
        ...(makeRender().options as Record<string, unknown>),
        models: [
          { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' },
          { id: 'deepseek-v4-pro', label: 'DeepSeek-V4.1-Pro' },
        ],
      },
    });
    after = makeRender({ step: 'probe', stepIndex: 7 });
    stubFetch();
    render(<OnboardingWizard onDone={() => {}} />);
    expect(await screen.findByRole('button', { name: /DeepSeek-V4\.1-Flash/ })).toBeTruthy();
    expect(screen.queryByLabelText(/模型 id/)).toBeNull();
  });
});
