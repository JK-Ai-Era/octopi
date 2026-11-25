/**
 * SkillReviewPanel — 技能审查队列/启用管理（skill-creator P3；设计 §5 人工审查面）。
 *
 * 列表 → 预览（SKILL.md + 文件清单 + 静态检查）→ 批准/驳回；登记表启停开关。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { OctopiClient } from '@octopi-agent/gateway/web/sdk/client';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey, getRegistryToken } from '../console-key';
import { useT } from '../i18n/react';

interface SkillRow {
  skillId: string;
  source: string;
  reviewStatus: string;
  enabled: boolean;
  unreviewed: boolean;
  contentHash: string;
  review?: { by: string; verdict: string; findings?: string; at: number };
}

interface SubmissionRow {
  submissionId: string;
  skillId: string;
  status: string;
  summary?: string;
  createdAt: number;
}

interface Preview {
  submissionId: string;
  skillId: string;
  status: string;
  contentHash: string;
  issues: Array<{ severity: string; code: string; message: string }>;
  files: Array<{ path: string; bytes: number }>;
  skillMd?: string;
}

export function SkillReviewPanel(): JSX.Element {
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
  const [agents, setAgents] = useState<Array<{ id: string }>>([]);
  const [agentId, setAgentId] = useState('');
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionRow[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [findings, setFindings] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!agentId) return;
    try {
      const data = await client.getSkills(agentId);
      setSkills(data?.skills ?? []);
      setSubmissions(data?.submissions ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, agentId]);

  useEffect(() => {
    void client
      .getAgents()
      .then((list) => {
        setAgents(list.map((a) => ({ id: a.id })));
        if (list[0]) setAgentId(list[0].id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 切 agent 清预览（预览锚定的是上一个 agent 的 submission）
  useEffect(() => {
    setPreview(null);
  }, [agentId]);

  const openPreview = useCallback(
    async (submissionId: string) => {
      try {
        setPreview(await client.getSkillSubmission(agentId, submissionId));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client, agentId],
  );

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
        setPreview(null);
        setFindings('');
        await reload();
      } catch (err) {
        setError(t('skillReview.opFailed', { error: err instanceof Error ? err.message : String(err) }));
      } finally {
        setBusy(false);
      }
    },
    [reload, t],
  );

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong>{t('skillReview.title')}</strong>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="small">
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}
            </option>
          ))}
        </select>
        <button className="btn-ghost small" onClick={() => void reload()} disabled={busy}>
          {t('skillReview.reload')}
        </button>
      </div>
      <div style={{ opacity: 0.7, fontSize: 12 }}>{t('skillReview.hint')}</div>
      {error && <div style={{ color: 'var(--danger, #c0392b)' }}>{error}</div>}

      <section>
        <h4>{t('skillReview.queueTitle')}</h4>
        {submissions.length === 0 && <div style={{ opacity: 0.6 }}>{t('skillReview.emptyQueue')}</div>}
        {submissions.map((s) => (
          <div key={s.submissionId} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
            <code>{s.skillId}</code>
            <span style={{ opacity: 0.6 }}>{s.status}</span>
            {s.summary && <span style={{ opacity: 0.8 }}>{s.summary}</span>}
            <button className="btn-ghost small" onClick={() => void openPreview(s.submissionId)} disabled={busy}>
              {t('skillReview.previewTitle')}
            </button>
          </div>
        ))}
      </section>

      {preview && (
        <section style={{ border: '1px solid var(--border, #8884)', borderRadius: 8, padding: 12 }}>
          <h4>
            {t('skillReview.previewTitle')} — <code>{preview.skillId}</code>
          </h4>
          {preview.issues.length > 0 && (
            <div>
              <div style={{ fontWeight: 600 }}>{t('skillReview.issuesLabel')}</div>
              {preview.issues.map((i, idx) => (
                <div key={idx} style={{ fontSize: 12, opacity: 0.85 }}>
                  [{i.severity}] {i.code}: {i.message}
                </div>
              ))}
            </div>
          )}
          <div style={{ fontWeight: 600 }}>{t('skillReview.filesLabel')}</div>
          <div style={{ fontSize: 12, fontFamily: 'monospace' }}>
            {preview.files.map((f) => (
              <div key={f.path}>
                {f.path} {f.bytes < 0 ? '(symlink!)' : `${f.bytes}B`}
              </div>
            ))}
          </div>
          <pre style={{ maxHeight: 260, overflow: 'auto', fontSize: 12, background: 'var(--code-bg, #0001)' }}>
            {preview.skillMd ?? '(missing SKILL.md)'}
          </pre>
          <div style={{ fontWeight: 600 }}>{t('skillReview.findingsLabel')}</div>
          <textarea
            placeholder={t('skillReview.findingsPlaceholder')}
            value={findings}
            onChange={(e) => setFindings(e.target.value)}
            rows={2}
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              className="btn-primary small"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  client.reviewSkill({
                    agentId,
                    skillId: preview.skillId,
                    verdict: 'approved',
                    findings: findings || undefined,
                    // 审查锚点：只批预览的这一代（期间重提则 conflict 重看）
                    expectedSubmissionId: preview.submissionId,
                  }),
                )
              }
            >
              {t('skillReview.approve')}
            </button>
            <button
              className="btn-ghost small"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  client.reviewSkill({
                    agentId,
                    skillId: preview.skillId,
                    verdict: 'rejected',
                    findings: findings || undefined,
                    expectedSubmissionId: preview.submissionId,
                  }),
                )
              }
            >
              {t('skillReview.reject')}
            </button>
          </div>
        </section>
      )}

      <section>
        <h4>{t('skillReview.registryTitle')}</h4>
        {skills.length === 0 && <div style={{ opacity: 0.6 }}>{t('skillReview.emptyRegistry')}</div>}
        {skills.map((r) => (
          <div key={r.skillId} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
            <code>{r.skillId}</code>
            <span style={{ opacity: 0.6 }}>
              {r.reviewStatus} · {r.source}
            </span>
            {r.unreviewed && <span style={{ opacity: 0.7 }}>{t('skillReview.unreviewed')}</span>}
            {r.review && (
              <span style={{ opacity: 0.7, fontSize: 12 }}>
                {t('skillReview.reviewedBy')}: {r.review.by}
              </span>
            )}
            <button
              className={r.enabled ? 'btn-ghost small' : 'btn-primary small'}
              disabled={busy || (!r.enabled && r.reviewStatus !== 'approved')}
              onClick={() =>
                void act(() => client.setSkillEnabled({ agentId, skillId: r.skillId, enabled: !r.enabled }))
              }
            >
              {r.enabled ? t('skillReview.disable') : t('skillReview.enable')}
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
