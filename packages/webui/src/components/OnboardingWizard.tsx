/**
 * Web 向导渲染器（§1：一套状态机 + 两个渲染器的 Web 侧）。
 * 状态机推进 / 校验 / 落盘全在服务端（/api/v1/onboarding/*，M2 单源），
 * 本组件只渲染当前步骤表单并回传事件。入口：URL 带 setup 参数（token 见 §7）或首启检测。
 */

import { useEffect, useState } from 'react';
import { resolveDefaultBase } from '../gateway-base';
import { probeErrorCopy, type ProbeErrorKind } from '@octopi-agent/engine/config-admin/error-copy.js';
import { useT } from '../i18n/react';

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
    adminPasswordRequired?: boolean;
  };
  notice?: 'back-at-first';
  probeError?: { kind: ProbeErrorKind; message: string };
  /** M-6 热应用结果（true=已即时生效；false=失败见 hotApplyError；undefined=未热应用需重启） */
  hotApplied?: boolean;
  hotApplyError?: string;
  /** 控制台准入密钥（`channels[type=http].apiKey`；仅收尾步骤下发——与 LLM provider key 无关） */
  consoleAccessKey?:
    | { kind: 'key'; value: string; source: string }
    | { kind: 'env-ref'; ref: string }
    | { kind: 'none' }
    | { kind: 'unreadable' };
  options: {
    languages: Array<{ id: string; label: string }>;
    deploymentModes: Array<{ id: string; label: string; description: string }>;
    providers: Array<{ id: string; label: string; keyHint: string; api: string; defaultBaseUrl: string }>;
    models: Array<{ id: string; label: string; contextWindow?: number }>;
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

/**
 * 控制台准入密钥卡（向导收尾）。
 *
 * 存在的理由：`initOctopi` 会随机生成 `channels[type=http].apiKey`，它只存在配置文件里；
 * 用户不知道去哪找，登录页却要填。收尾时必须亮出来让用户复制保存。
 *
 * 注意：这是**控制台准入密钥**，不是 LLM provider 的密钥——后者永不回显。
 *
 * @param accessKey - 服务端判定的密钥四态（缺省 = 服务端未下发，不渲染）
 */
function AccessKeyCard({ accessKey }: { accessKey?: WizardRender['consoleAccessKey'] }): JSX.Element | null {
  const t = useT();
  const [copied, setCopied] = useState(false);
  if (!accessKey) return null;

  if (accessKey.kind === 'none') {
    return (
      <div className="status-card" role="status">
        <div className="status-card-title">{t('onboardingWizard.accessKeyNoneTitle')}</div>
        <div className="status-card-detail">{t('onboardingWizard.accessKeyNoneDetail')}</div>
      </div>
    );
  }
  if (accessKey.kind === 'env-ref') {
    return (
      <div className="status-card" role="status">
        <div className="status-card-title">{t('onboardingWizard.accessKeyEnvTitle')}</div>
        <div className="status-card-detail">
          <code>{accessKey.ref}</code>
          {t('onboardingWizard.accessKeyEnvDetail')}
        </div>
      </div>
    );
  }
  if (accessKey.kind === 'unreadable') {
    return (
      <div className="status-card" role="status">
        <div className="status-card-title">{t('onboardingWizard.accessKeyUnreadableTitle')}</div>
        <div className="status-card-detail">{t('onboardingWizard.accessKeyUnreadableDetail')}</div>
      </div>
    );
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(accessKey.value);
      setCopied(true);
    } catch {
      // 剪贴板不可用（非安全上下文/无权限）：文本已可见，用户可手动选中复制——不回退到 execCommand
      setCopied(false);
    }
  };

  return (
    <div className="status-card" role="status">
      <div className="status-card-title">{t('onboardingWizard.accessKeyTitle')}</div>
      <div className="status-card-detail">
        {/* 密钥单行可选中：`user-select: all` 让双击即全选，剪贴板不可用时也能复制 */}
        <code className="access-key-value" style={{ userSelect: 'all', wordBreak: 'break-all' }}>
          {accessKey.value}
        </code>
      </div>
      {accessKey.value !== accessKey.source && (
        <div className="status-card-detail small muted">
          {t('onboardingWizard.accessKeyResolvedFrom', { ref: accessKey.source })}
        </div>
      )}
      <div className="status-card-detail">{t('onboardingWizard.accessKeyDetail')}</div>
      <button className="btn-secondary" style={{ marginTop: 8 }} onClick={() => void copy()} disabled={copied}>
        {copied ? t('onboardingWizard.accessKeyCopied') : t('onboardingWizard.accessKeyCopy')}
      </button>
    </div>
  );
}

export function OnboardingWizard({ onDone }: { onDone: () => void }): JSX.Element {
  const t = useT();
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
    // M-4：密码二次确认是硬校验（此前收集了但不比对，形同装饰）。
    // 只在「当前是组织模式」时比对：切回个人模式后确认框已卸载，若还拿残留的
    // draft.adminPassword 比对，会报「两次输入不一致」而用户根本无处修正（死锁）。
    const draftMode = (draft.deploymentMode as string | undefined) ?? render?.choices.deploymentMode ?? 'personal';
    if (
      event.kind === 'next' &&
      draftMode !== 'personal' &&
      draft.adminPassword !== undefined &&
      draft.adminPassword !== adminPassword2
    ) {
      setError(t('onboardingWizard.passwordMismatch'));
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
      // 确认框也一并清空：否则回退再进本步时它仍留着上一轮明文，二次确认形同虚设。
      setAdminPassword2('');
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
        <div className="small muted">
          {error ? t('onboardingWizard.startFailed', { error }) : t('onboardingWizard.starting')}
        </div>
      </div>
    );
  }

  const step = render.step;
  const body = ((): JSX.Element => {
    switch (step) {
      case 'welcome':
        return (
          <div className="wizard-step">
            <h2>{t('onboardingWizard.welcomeTitle')}</h2>
            <p className="small muted">{t('onboardingWizard.welcomeHint')}</p>
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
            <h2>{t('onboardingWizard.initModeTitle')}</h2>
            <p className="small muted">{t('onboardingWizard.initModeHint')}</p>
            <div className="wizard-cards">
              <button className="btn-primary wizard-card" onClick={() => void submit({ kind: 'next' }, { initMode: 'web' })}>
                {t('onboardingWizard.initModeWeb')}
              </button>
              <button className="btn-secondary wizard-card" onClick={() => void submit({ kind: 'next' }, { initMode: 'cli' })}>
                {t('onboardingWizard.initModeCli')}
              </button>
            </div>
          </div>
        );
      case 'deployment-mode': {
        // 选中态必须取自「未提交的草稿优先」：只读 render.choices.deploymentMode（服务端已保存值）
        // 会导致点第二/第三项毫无视觉反馈、密码框也不出现——用户以为选不中（真机上就是这样）。
        const selectedMode =
          (draft.deploymentMode as string | undefined) ?? render.choices.deploymentMode ?? 'personal';
        // 是否显示密码框：按服务端同源判据（②③恒需；个人仅在远程绑定时需）。
        // 只看 selectedMode 会让「个人+远程绑定」用户完全没有输密码的入口，提交才被拒。
        const pwRequired =
          selectedMode !== 'personal' || render.choices.adminPasswordRequired === true;
        return (
          <div className="wizard-step">
            <h2>{t('onboardingWizard.deploymentTitle')}</h2>
            <div className="wizard-cards">
              {render.options.deploymentModes.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={selectedMode === o.id}
                  className={selectedMode === o.id ? 'btn-primary wizard-card wizard-card-tall' : 'btn-secondary wizard-card wizard-card-tall'}
                  onClick={() => setDraft((d) => ({ ...d, deploymentMode: o.id }))}
                >
                  <b>{o.label}</b>
                  <span className="small">{o.description}</span>
                </button>
              ))}
            </div>
            {pwRequired && (
              <div className="wizard-form">
                {selectedMode === 'multi-organization' && (
                  <label className="small">
                    {t('onboardingWizard.orgNameLabel')}
                    <input
                      value={String(draft.orgName ?? render.choices.orgName ?? '')}
                      onChange={(e) => setDraft((d) => ({ ...d, orgName: e.target.value }))}
                    />
                  </label>
                )}
                <label className="small">
                  {t('onboardingWizard.adminPasswordLabel')}
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={String(draft.adminPassword ?? '')}
                    onChange={(e) => setDraft((d) => ({ ...d, adminPassword: e.target.value }))}
                    placeholder={
                      render.choices.hasAdminPassword
                        ? t('onboardingWizard.adminPasswordKeep')
                        : undefined
                    }
                  />
                </label>
                {/* 已设置过密码时（回退重进本步），服务端仍保留着它，留空即保持原值——
                    此时不该喊「必填」并标红，否则界面与真实状态自相矛盾。 */}
                {!String(draft.adminPassword ?? '').trim() && !render.choices.hasAdminPassword && (
                  <div className="small status-error">{t('onboardingWizard.adminPasswordRequired')}</div>
                )}
                <label className="small">
                  {t('onboardingWizard.adminPasswordConfirmLabel')}
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={adminPassword2}
                    onChange={(e) => setAdminPassword2(e.target.value)}
                  />
                </label>
              </div>
            )}
            <div className="wizard-nav">
              <button
                className="btn-primary"
                onClick={() =>
                  // 只提交当前模式相关字段：不要求密码时必须显式清空 adminPassword/orgName，
                  // 否则切回 personal 后残留的密码会被服务端白名单合并、落盘时给 default 用户设上
                  // （卡片文案承诺「无需账号密码」，那是静默与承诺相反的副作用）。
                  void submit(
                    { kind: 'next' },
                    pwRequired
                      ? { deploymentMode: selectedMode }
                      : { deploymentMode: 'personal', adminPassword: '', orgName: '' },
                  )
                }
                disabled={busy}
              >
                {t('onboardingWizard.next')}
              </button>
            </div>
          </div>
        );
      }
      case 'provider': {
        const isCustom = draft.providerId === 'custom' || render.choices.providerId === 'custom';
        return (
          <div className="wizard-step">
            <h2>{t('onboardingWizard.providerTitle')}</h2>
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
                  {t('onboardingWizard.baseUrlLabel')}
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
                  {t('onboardingWizard.next')}
                </button>
              </>
            )}
          </div>
        );
      }
      case 'api-key':
        return (
          <div className="wizard-step">
            <h2>{t('onboardingWizard.apiKeyTitle')}</h2>
            <p className="small muted">
              {render.options.providers.find((p) => p.id === render.choices.providerId)?.keyHint ?? t('onboardingWizard.apiKeyHintFallback')}
              {' '}{t('onboardingWizard.apiKeyHintSuffix')}
            </p>
            <div className="wizard-form">
              <label className="small">
                API Key
                <input type="password" onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))} placeholder={render.choices.hasApiKey ? t('onboardingWizard.apiKeyPlaceholderSet') : 'sk-…'} />
              </label>
            </div>
            <button className="btn-primary" onClick={() => void submit({ kind: 'next' })} disabled={busy}>
              {t('onboardingWizard.next')}
            </button>
          </div>
        );
      case 'model': {
        const presetModels = render.options.models ?? [];
        const current = String(draft.modelId ?? render.choices.modelId ?? '');
        const manual = draft.manualModel === true || (current !== '' && !presetModels.some((m) => m.id === current));
        return (
          <div className="wizard-step">
            <h2>{t('onboardingWizard.modelTitle')}</h2>
            <p className="small muted">{t('onboardingWizard.modelHint')}</p>
            {presetModels.length > 0 && !manual && (
              <div className="wizard-cards">
                {presetModels.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={current === m.id}
                    className={current === m.id ? 'btn-primary wizard-card wizard-card-tall' : 'btn-secondary wizard-card wizard-card-tall'}
                    onClick={() => void submit({ kind: 'next' }, { modelId: m.id })}
                  >
                    <b>{m.label}</b>
                    <span className="small muted">
                      {m.id}
                      {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ctx` : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="wizard-form">
              {(manual || presetModels.length === 0) && (
                <label className="small">
                  {t('onboardingWizard.modelIdLabel')}
                  <input
                    value={current}
                    onChange={(e) => setDraft((d) => ({ ...d, modelId: e.target.value }))}
                    placeholder="gpt-6.1-terra / deepseek-flash / …"
                  />
                </label>
              )}
            </div>
            {presetModels.length > 0 && !manual && (
              <button className="btn-ghost small" type="button" onClick={() => setDraft((d) => ({ ...d, manualModel: true, modelId: '' }))}>
                {t('onboardingWizard.modelManual')}
              </button>
            )}
            {(manual || presetModels.length === 0) && (
              <div className="wizard-nav">
                <button className="btn-primary" onClick={() => void submit({ kind: 'next' })} disabled={busy}>
                  {t('onboardingWizard.next')}
                </button>
              </div>
            )}
          </div>
        );
      }
      case 'probe':
        return (
          <div className="wizard-step">
            <h2>{t('onboardingWizard.probeTitle')}</h2>
            <p className="small muted">{t('onboardingWizard.probeHint')}</p>
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
              {render.probeError ? t('onboardingWizard.probeRetry') : t('onboardingWizard.probeStart')}
            </button>
          </div>
        );
      case 'services':
        return (
          <div className="wizard-step">
            <h2>{t('onboardingWizard.servicesTitle')}</h2>
            <p className="small muted">{t('onboardingWizard.servicesHint')}</p>
            <button className="btn-primary" onClick={() => void submit({ kind: 'next' })} disabled={busy}>
              {t('onboardingWizard.next')}
            </button>
          </div>
        );
      case 'first-chat':
        return (
          <div className="wizard-step">
            <h2>{t('onboardingWizard.doneTitle')}</h2>
            <p className="small muted">{t('onboardingWizard.doneHint')}</p>
            <AccessKeyCard accessKey={render.consoleAccessKey} />
            <button className="btn-primary" onClick={() => void submit({ kind: 'next' })} disabled={busy}>
              {t('onboardingWizard.startChat')}
            </button>
          </div>
        );
      default:
        return (
          <div className="wizard-step">
            <h2>{t('onboardingWizard.finishedTitle')}</h2>
            <p className="small muted">
              {render.completed ? t('onboardingWizard.finishedCompleted') : t('onboardingWizard.finishedAborted')}
            </p>
            <button className="btn-primary" onClick={onDone}>
              {t('onboardingWizard.enterChat')}
            </button>
          </div>
        );
    }
  })();

  return (
    <div className="panel wizard-panel">
      {render.completed && render.hotApplied === true && (
        <div className="status-card" role="status">
          <div className="status-card-title">{t('onboardingWizard.hotAppliedTitle')}</div>
          <div className="status-card-detail">
            {t('onboardingWizard.hotAppliedDetail')}
          </div>
        </div>
      )}
      {render.completed && render.hotApplied === false && (
        <div className="error-card error-card-user-action" role="status">
          <div className="error-card-title">{t('onboardingWizard.hotApplyFailedTitle')}</div>
          <div className="error-card-detail">
            {render.hotApplyError}{t('onboardingWizard.hotApplyFailedSeparator')}
            <code>octopi serve restart</code>{t('onboardingWizard.hotApplyFailedAfter')}
          </div>
        </div>
      )}
      {render.completed && render.hotApplied === undefined && (
        <div className="error-card error-card-user-action" role="status">
          <div className="error-card-title">{t('onboardingWizard.savedTitle')}</div>
          <div className="error-card-detail">
            {t('onboardingWizard.restartRequiredPrefix')}<code>octopi serve restart</code>
            {t('onboardingWizard.restartRequiredSuffix')}
          </div>
        </div>
      )}
      {step && render.stepCount > 0 ? (
        <div className="wizard-progress">
          <span>{t('onboardingWizard.footerTitle')}</span>
          <div
            className="wizard-progress-bar"
            role="progressbar"
            aria-valuenow={render.stepIndex}
            aria-valuemin={1}
            aria-valuemax={render.stepCount}
          >
            <div className="wizard-progress-fill" style={{ width: `${(render.stepIndex / render.stepCount) * 100}%` }} />
          </div>
          <span>{t('onboardingWizard.stepProgress', { index: render.stepIndex, count: render.stepCount })}</span>
        </div>
      ) : (
        <div className="small muted">{t('onboardingWizard.footerTitle')}</div>
      )}
      {body}
      {error && <div className="small status-error" style={{ marginTop: 8 }}>{error}</div>}
      {render.notice === 'back-at-first' && <div className="small muted">{t('onboardingWizard.backAtFirst')}</div>}
      {step !== null && step !== 'welcome' && step !== 'provider' && (
        <div className="wizard-nav">
          <button className="btn-ghost small" onClick={() => void submit({ kind: 'back' })} disabled={busy}>
            {t('onboardingWizard.back')}
          </button>
          <button className="btn-ghost small" onClick={() => void submit({ kind: 'exit', save: false })} disabled={busy}>
            {t('onboardingWizard.exitNoSave')}
          </button>
        </div>
      )}
    </div>
  );
}
