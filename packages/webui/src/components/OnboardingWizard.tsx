/**
 * Web 向导渲染器（§1：一套状态机 + 两个渲染器的 Web 侧）。
 * 状态机推进 / 校验 / 落盘全在服务端（/api/v1/onboarding/*，M2 单源），
 * 本组件只渲染当前步骤表单并回传事件。入口：URL 带 setup 参数（token 见 §7）或首启检测。
 */

import { useEffect, useState } from 'react';
import { resolveDefaultBase } from '../gateway-base';
import { probeErrorCopy, type ProbeErrorKind } from '@octopi-agent/engine/config-admin/error-copy.js';

interface WizardRender {
  /** 步骤进度（服务端 ONBOARDING_STEPS 派生——前端不自维护步骤序） */
  stepIndex: number;
  stepCount: number;
  step: string | null;
  completed: boolean;
  aborted: boolean;
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
  probeError?: { kind: ProbeErrorKind; message: string };
  /** 演示任务包播种失败的非致命警告（主配置已保存） */
  demoWarning?: string;
  /** M-6 热应用结果（true=已即时生效；false=失败见 hotApplyError；undefined=未热应用需重启） */
  hotApplied?: boolean;
  hotApplyError?: string;
  options: {
    languages: Array<{ id: string; label: string }>;
    deploymentModes: Array<{ id: string; label: string; description: string }>;
    providers: Array<{ id: string; label: string; keyHint: string; api: string; defaultBaseUrl: string }>;
  };
}

const setupToken = new URLSearchParams(window.location.search).get('setup') ?? undefined;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${resolveDefaultBase()}/api/v1/onboarding${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(setupToken ? { 'X-Setup-Token': setupToken } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json()) as { ok: boolean; data?: T; error?: string };
  if (!body.ok || body.data === undefined) throw new Error(body.error ?? `http_${res.status}`);
  return body.data;
}

/** probe 分类码 → 人话文案（与 error-classify 同口径的向导语境文案） */
function probeCopy(kind: ProbeErrorKind): { title: string; detail: string } {
  // 文案单源在 engine error-copy（批 3-2 四份单源化）；此函数保留语义别名
  return probeErrorCopy(kind, 'zh');
}

export function OnboardingWizard({ onDone }: { onDone: () => void }): JSX.Element {
  const [render, setRender] = useState<WizardRender | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 草稿（本步表单值；随事件上送，服务端白名单合并）
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [adminPassword2, setAdminPassword2] = useState('');

  useEffect(() => {
    api<WizardRender>('/session', { method: 'POST' })
      .then(setRender)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const submit = async (event: { kind: string; save?: boolean }, extra?: Record<string, unknown>): Promise<void> => {
    // M-4：密码二次确认是硬校验（此前收集了但不比对，形同装饰）
    if (event.kind === 'next' && draft.adminPassword !== undefined && draft.adminPassword !== adminPassword2) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<WizardRender>('/session/event', {
        method: 'POST',
        body: JSON.stringify({ event: event, stepData: { ...draft, ...(extra ?? {}) } }),
      });
      setRender(r);
      setDraft({});
      if (r.completed) onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!render) {
    return (
      <div className="panel" style={{ margin: 48, maxWidth: 560 }}>
        <div className="small muted">{error ? `无法启动向导：${error}` : '正在启动配置向导…'}</div>
      </div>
    );
  }

  const step = render.step;
  const mode = render.choices.deploymentMode ?? 'personal';
  const body = ((): JSX.Element => {
    switch (step) {
      case 'welcome':
        return (
          <div className="wizard-step">
            <h2>三分钟让你的助手跑起来 🐙</h2>
            <p className="small muted">先选一个界面语言（之后可在设置中修改）。</p>
            <div className="wizard-cards">
              {render.options.languages.map((o) => (
                <button
                  key={o.id}
                  className={render.choices.lang === o.id ? 'btn-primary wizard-card' : 'btn-secondary wizard-card'}
                  onClick={() => void submit({ kind: 'next' }, { lang: o.id })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        );
      case 'init-mode':
        return (
          <div className="wizard-step">
            <h2>选一种初始化方式</h2>
            <p className="small muted">你现在在 Web 向导中；也可以全程用命令行（octopi init）。</p>
            <div className="wizard-cards">
              <button className="btn-primary wizard-card" onClick={() => void submit({ kind: 'next' }, { initMode: 'web' })}>
                就在这里配置（Web）
              </button>
              <button className="btn-secondary wizard-card" onClick={() => void submit({ kind: 'next' }, { initMode: 'cli' })}>
                去命令行配置
              </button>
            </div>
          </div>
        );
      case 'deployment-mode':
        return (
          <div className="wizard-step">
            <h2>你打算怎么用？</h2>
            <div className="wizard-cards">
              {render.options.deploymentModes.map((o) => (
                <button
                  key={o.id}
                  className={mode === o.id ? 'btn-primary wizard-card wizard-card-tall' : 'btn-secondary wizard-card wizard-card-tall'}
                  onClick={() => setDraft((d) => ({ ...d, deploymentMode: o.id }))}
                >
                  <b>{o.label}</b>
                  <span className="small">{o.description}</span>
                </button>
              ))}
            </div>
            {mode !== 'personal' && (
              <div className="wizard-form">
                {mode === 'multi-organization' && (
                  <label className="small">
                    组织名称
                    <input value={String(draft.orgName ?? render.choices.orgName ?? '')} onChange={(e) => setDraft((d) => ({ ...d, orgName: e.target.value }))} />
                  </label>
                )}
                <label className="small">
                  管理员密码
                  <input type="password" onChange={(e) => setDraft((d) => ({ ...d, adminPassword: e.target.value }))} />
                </label>
                <label className="small">
                  再输一遍
                  <input type="password" value={adminPassword2} onChange={(e) => setAdminPassword2(e.target.value)} />
                </label>
              </div>
            )}
            <button className="btn-primary" onClick={() => void submit({ kind: 'next' })} disabled={busy}>
              下一步
            </button>
          </div>
        );
      case 'provider': {
        const isCustom = draft.providerId === 'custom' || render.choices.providerId === 'custom';
        return (
          <div className="wizard-step">
            <h2>选择模型服务</h2>
            <div className="wizard-cards">
              {render.options.providers.map((o) => (
                <button
                  key={o.id}
                  className={(draft.providerId ?? render.choices.providerId) === o.id ? 'btn-primary wizard-card' : 'btn-secondary wizard-card'}
                  onClick={() => {
                    if (o.id === 'custom') {
                      // M-5：custom 还要 Base URL——先选中，填好 URL 再下一步（此前直接 next 必 400，死路）
                      setDraft((d) => ({ ...d, providerId: 'custom' }));
                    } else {
                      void submit({ kind: 'next' }, { providerId: o.id });
                    }
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {isCustom && (
              <>
                <label className="small">
                  Base URL（OpenAI 兼容接口地址）
                  <input
                    type="text"
                    placeholder="http://localhost:11434/v1"
                    value={String((draft.providerOverrides as { baseUrl?: string } | undefined)?.baseUrl ?? '')}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, providerOverrides: { ...(d.providerOverrides ?? {}), baseUrl: e.target.value } }))
                    }
                  />
                </label>
                <button
                  className="btn-primary"
                  onClick={() =>
                    void submit({ kind: 'next' }, { providerId: 'custom', providerOverrides: draft.providerOverrides })
                  }
                >
                  下一步
                </button>
              </>
            )}
          </div>
        );
      }
      case 'api-key':
        return (
          <div className="wizard-step">
            <h2>录入 API Key</h2>
            <p className="small muted">
              {render.options.providers.find((p) => p.id === render.choices.providerId)?.keyHint ?? '在模型服务官网获取 API Key。'}
              {' '}Key 只保存在本机（.env，0600），不会明文进配置。
            </p>
            <div className="wizard-form">
              <label className="small">
                API Key
                <input type="password" onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))} placeholder={render.choices.hasApiKey ? '已录入（留空保持不变）' : 'sk-…'} />
              </label>
            </div>
            <button className="btn-primary" onClick={() => void submit({ kind: 'next' })} disabled={busy}>
              下一步
            </button>
          </div>
        );
      case 'model':
        return (
          <div className="wizard-step">
            <h2>选择模型</h2>
            <p className="small muted">填一个模型 id（如 deepseek-chat）；不确定就用服务默认。</p>
            <div className="wizard-form">
              <label className="small">
                模型 id
                <input value={String(draft.modelId ?? render.choices.modelId ?? '')} onChange={(e) => setDraft((d) => ({ ...d, modelId: e.target.value }))} />
              </label>
            </div>
            <button className="btn-primary" onClick={() => void submit({ kind: 'next' })} disabled={busy}>
              下一步
            </button>
          </div>
        );
      case 'probe':
        return (
          <div className="wizard-step">
            <h2>测通</h2>
            <p className="small muted">用你填的配置真发一次请求验证。</p>
            {render.probeError && (() => {
              const c = probeCopy(render.probeError!.kind);
              return (
                <div className="error-card error-card-user-action" style={{ marginBottom: 12 }} title={render.probeError?.message}>
                  <div className="error-card-title">⚠ {c.title}</div>
                  <div className="error-card-detail">{c.detail}</div>
                </div>
              );
            })()}
            <button className="btn-primary" onClick={() => void submit({ kind: 'next' })} disabled={busy}>
              {render.probeError ? '重试测通' : '开始测通'}
            </button>
          </div>
        );
      case 'services':
        return (
          <div className="wizard-step">
            <h2>准备起服务</h2>
            <p className="small muted">配置已保存。下一步完成后即可开始第一句话。</p>
            <button className="btn-primary" onClick={() => void submit({ kind: 'next' })} disabled={busy}>
              下一步
            </button>
          </div>
        );
      case 'first-chat':
        return (
          <div className="wizard-step">
            <h2>完成 🎉</h2>
            <p className="small muted">一切就绪——现在就可以和你的助手开始第一句话。</p>
            <button className="btn-primary" onClick={() => void submit({ kind: 'next' })} disabled={busy}>
              开始第一句话
            </button>
          </div>
        );
      default:
        return (
          <div className="wizard-step">
            <h2>向导已结束</h2>
            <p className="small muted">{render.completed ? '配置完成。' : '向导中止，配置未改。'}</p>
            <button className="btn-primary" onClick={onDone}>
              进入对话
            </button>
          </div>
        );
    }
  })();

  return (
    <div className="panel wizard-panel">
      {render.completed && render.hotApplied === true && (
        <div className="status-card" role="status">
          <div className="status-card-title">配置已保存并即时生效</div>
          <div className="status-card-detail">
            新会话即用新配置，无需重启。现在就可以点「进入对话」开始使用。
          </div>
        </div>
      )}
      {render.completed && render.hotApplied === false && (
        <div className="error-card error-card-user-action" role="status">
          <div className="error-card-title">配置已保存（热应用失败，需重启）</div>
          <div className="error-card-detail">
            {render.hotApplyError} —— 请运行 <code>octopi serve restart</code> 使新配置生效。
          </div>
        </div>
      )}
      {render.completed && render.hotApplied === undefined && (
        <div className="error-card error-card-user-action" role="status">
          <div className="error-card-title">配置已保存</div>
          <div className="error-card-detail">
            重启服务后生效：<code>octopi serve restart</code>。在此之前，对话所用的仍是旧配置。
          </div>
        </div>
      )}
      {render.completed && render.demoWarning && (
        <div className="error-card error-card-user-action" role="status">
          <div className="error-card-title">示例任务包未播种</div>
          <div className="error-card-detail">
            {render.demoWarning} —— 主配置已保存，不受影响；示例助手与样例资料未就绪，「试试这个示例」暂不可用。
          </div>
        </div>
      )}
      <div className="small muted">
        首启配置向导
        {step && render.stepCount > 0 && <span> · 第 {render.stepIndex}/{render.stepCount} 步</span>}
      </div>
      {body}
      {error && <div className="small status-error" style={{ marginTop: 8 }}>{error}</div>}
      {render.notice === 'back-at-first' && <div className="small muted">已经是第一步了。</div>}
      {step !== null && step !== 'welcome' && step !== 'provider' && (
        <div className="wizard-nav">
          <button className="btn-ghost small" onClick={() => void submit({ kind: 'back' })} disabled={busy}>
            ← 上一步
          </button>
          <button className="btn-ghost small" onClick={() => void submit({ kind: 'exit', save: false })} disabled={busy}>
            退出（不保存）
          </button>
        </div>
      )}
    </div>
  );
}
