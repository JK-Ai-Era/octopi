/**
 * BrowserSettingsPanel — 浏览器引擎设置面板（arch/browser-capability.md §3.9）
 *
 * 引擎状态卡（就绪/缺失 + 依据）→ 一键安装（异步任务 + 进度轮询控制台）→
 * 引擎切换（config hash 乐观锁，热生效 L1：新 run 生效）。
 * 安装逻辑单一实现在 engine 的 integration/browser/install.ts（CLI 共用）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  OctopiClient,
  type BrowserEngineStatusDto,
  type BrowserInstallJobDto,
} from '@octopi-agent/gateway/web/sdk/client';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey, getRegistryToken } from '../console-key';
import { useT } from '../i18n/react';

const ENGINE_OPTIONS = [
  'auto',
  'playwright',
  'stealth',
  'rebrowser',
  'camoufox',
  'cdp-attach',
] as const;

const INSTALLABLE = new Set(['playwright', 'rebrowser', 'camoufox', 'stealth']);

export function BrowserSettingsPanel() {
  const t = useT();
  const client = useMemo(
    () =>
      new OctopiClient({
        baseUrl: resolveDefaultBase(),
        apiKey: getConsoleKey() || undefined,
        registryToken: getRegistryToken() || undefined,
      }),
    [],
  );

  const [config, setConfig] = useState<{ engine: string; hash: string } | null>(null);
  const [statuses, setStatuses] = useState<BrowserEngineStatusDto[]>([]);
  const [job, setJob] = useState<BrowserInstallJobDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [cfg, st] = await Promise.all([client.getBrowserConfig(), client.getBrowserEngines()]);
      setConfig(cfg);
      setStatuses(st);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 安装任务轮询（router 无流式基建——2s 轮询足够安装场景）
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const timer = setInterval(() => {
      void client
        .pollBrowserInstall(job.id)
        .then((next) => {
          if (next) {
            setJob(next);
            if (next.status !== 'running') void refresh();
          }
        })
        .catch(() => {
          /* 轮询失败静默重试下一轮（安装本身不受影响） */
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [client, job, refresh]);

  // 进度滚到底
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.lines.length]);

  const install = async (engine: string) => {
    setError(null);
    setSavedNote(null);
    try {
      const started = await client.installBrowserEngine(engine);
      setJob(started);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveEngine = async () => {
    if (!config) return;
    setError(null);
    setSavedNote(null);
    try {
      const result = await client.setBrowserEngine(config.engine, config.hash);
      setConfig({ engine: config.engine, hash: result.hash });
      setSavedNote(t('browserSettings.saved'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="panel" style={{ display: 'grid', gap: 12 }}>
      <h3 style={{ margin: 0 }}>{t('browserSettings.title')}</h3>
      <p className="small muted" style={{ margin: 0 }}>
        {t('browserSettings.subtitle')}
      </p>

      {/* 引擎切换（热生效 L1：新 run 生效） */}
      <label className="small" style={{ display: 'grid', gap: 4, maxWidth: 420 }}>
        {t('browserSettings.currentEngine')}
        <select
          value={config?.engine ?? 'auto'}
          onChange={(e) => setConfig((c) => (c ? { ...c, engine: e.target.value } : c))}
        >
          {ENGINE_OPTIONS.map((engine) => (
            <option key={engine} value={engine}>
              {engine}
            </option>
          ))}
        </select>
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" onClick={() => void saveEngine()}>
          {t('browserSettings.save')}
        </button>
        {savedNote ? <span className="small muted">{savedNote}</span> : null}
      </div>

      {/* 引擎状态卡 + 一键安装 */}
      <h4 style={{ margin: '8px 0 0' }}>{t('browserSettings.status')}</h4>
      <div style={{ display: 'grid', gap: 8 }}>
        {statuses.map((s) => (
          <div
            key={s.engine}
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              border: '1px solid var(--border, #333)',
              borderRadius: 6,
              padding: '8px 12px',
            }}
          >
            <strong style={{ minWidth: 96 }}>{s.engine}</strong>
            <span
              className="small"
              style={{ color: s.ready ? 'var(--ok, #2a2)' : 'var(--warn, #c60)', minWidth: 72 }}
            >
              {s.ready ? t('browserSettings.ready') : t('browserSettings.missing')}
            </span>
            <span className="small muted" style={{ flex: 1 }}>
              {s.detail}
            </span>
            {INSTALLABLE.has(s.engine) ? (
              <button
                type="button"
                disabled={job?.status === 'running'}
                onClick={() => void install(s.engine)}
              >
                {job?.status === 'running' && job.engine === s.engine
                  ? t('browserSettings.installing')
                  : t('browserSettings.install')}
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {/* 安装进度控制台 */}
      {job ? (
        <div style={{ display: 'grid', gap: 4 }}>
          <h4 style={{ margin: '8px 0 0' }}>
            {t('browserSettings.progress')} — {job.engine}{' '}
            {job.status === 'done'
              ? t('browserSettings.installDone')
              : job.status === 'failed'
                ? t('browserSettings.installFailed')
                : t('browserSettings.installing')}
          </h4>
          <pre
            ref={logRef}
            className="small"
            style={{
              margin: 0,
              maxHeight: 260,
              overflow: 'auto',
              background: 'var(--bg-2, #111)',
              color: 'var(--fg, #ddd)',
              padding: 8,
              borderRadius: 6,
            }}
          >
            {job.lines.join('\n')}
          </pre>
          {job.truncated ? (
            <span className="small muted">{t('browserSettings.logTruncated')}</span>
          ) : null}
          {job.detail ? <span className="small muted">{job.detail}</span> : null}
        </div>
      ) : null}

      {error ? <div className="small" style={{ color: 'var(--err, #c22)' }}>{error}</div> : null}
    </div>
  );
}
