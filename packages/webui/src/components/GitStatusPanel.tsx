/**
 * 右栏「Git」页签 — 选定目录的 git 工作区状态（只读，轮询刷新）
 *
 * 数据源：GET /api/v1/sessions/:id/git-status（Gateway 用 engine 加固 git runner 组装，
 * 与 agent 的 git_* 工具同一安全执行路径）。目录选项 = 会话/agent roots
 * （configuredRoots + temporaryRoots），服务端按同一 roots 集合做围栏校验。
 *
 * 轮询语义：选中目录立即拉一次，之后按 web.gitStatusPollSeconds 配置的间隔轮询
 * （下发缺失回退 5s；0 = 不自动轮询——选中/切换目录与手动刷新仍即时）；切换目录
 * 立即刷新并作废旧响应；document.hidden 时暂停轮询；页签卸载即停表。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GitStatusBranchView,
  GitStatusEntryView,
  GitStatusView,
  OctopiClient,
} from '@octopi-agent/gateway/web/sdk/client';
import { getGitStatusPollSeconds } from '../runtime-config';

const GROUPS: Array<{ key: GitStatusEntryView['group']; label: string; color: string }> = [
  { key: 'conflicted', label: '冲突', color: 'var(--color-error)' },
  { key: 'staged', label: '已暂存', color: 'var(--color-ok)' },
  { key: 'unstaged', label: '未暂存', color: 'var(--color-warn)' },
  { key: 'untracked', label: '未跟踪', color: 'var(--color-muted)' },
];

function rootStorageKey(agentId: string | undefined): string {
  return `octopi.webui.git-status.root.${agentId || 'default'}`;
}

/** 分支徽章文本：detached / 初始仓库 / 分支 + upstream + ahead-behind */
function branchLabel(b: GitStatusBranchView): string {
  if (b.detached) return `detached @ ${(b.oid ?? '').slice(0, 7)}`;
  const head = b.head ?? '(unknown)';
  if (b.initial) return `${head} · 尚无提交`;
  const up = b.upstream ? ` → ${b.upstream}` : '';
  const ab = b.ahead != null ? ` ↑${b.ahead} ↓${b.behind}` : '';
  return `${head}${up}${ab}`;
}

/** 渲染用 XY 状态码（'.' → 空格） */
function xyCode(e: GitStatusEntryView): string {
  return `${e.x === '.' ? ' ' : e.x}${e.y === '.' ? ' ' : e.y}`;
}

export function GitStatusPanel({
  client,
  sessionId,
  agentId,
}: {
  client: OctopiClient | null;
  sessionId: string | null;
  agentId?: string;
}) {
  const [roots, setRoots] = useState<{ configured: string[]; temporary: string[] } | null>(null);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<GitStatusView | null>(null);
  /** 快照所属的请求身份（sessionId|selected）——渲染只认它，不认服务端回显路径 */
  const [snapshotKey, setSnapshotKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  /** 轮询间隔（秒）：octopi.json web.gitStatusPollSeconds 下发，0 = 不自动轮询 */
  const pollSeconds = useMemo(() => getGitStatusPollSeconds(), []);
  const seqRef = useRef(0);
  const inFlightRef = useRef(false);

  // ── roots 加载 + 选中目录恢复（localStorage 按 agentId 记忆） ──
  useEffect(() => {
    let cancelled = false;
    if (!client || !sessionId) {
      setRoots(null);
      setSelected(null);
      return;
    }
    (async () => {
      try {
        const data = await client.getSessionEffectRoots(sessionId);
        if (cancelled) return;
        const configured = data.configuredRoots ?? [];
        const temporary = data.temporaryRoots ?? [];
        const all = [...configured, ...temporary];
        setRoots({ configured, temporary });
        setRootsError(null);
        setSelected((cur) => {
          if (cur && all.includes(cur)) return cur;
          try {
            const saved = window.localStorage.getItem(rootStorageKey(agentId));
            if (saved && all.includes(saved)) return saved;
          } catch {
            // localStorage 不可用（隐私模式等）：放弃持久化，不影响功能
          }
          return all[0] ?? null;
        });
      } catch (err) {
        if (!cancelled) setRootsError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, agentId]);

  // ── 选中目录持久化 ──
  useEffect(() => {
    if (!selected) return;
    try {
      window.localStorage.setItem(rootStorageKey(agentId), selected);
    } catch {
      // 同上：持久化失败不影响功能
    }
  }, [selected, agentId]);

  // ── 拉取：force=true 绕过 in-flight 去重（切目录/手动刷新） ──
  const refresh = useCallback(
    async (force: boolean) => {
      if (!client || !sessionId || !selected) return;
      if (!force && inFlightRef.current) return;
      const seq = ++seqRef.current;
      inFlightRef.current = true;
      try {
        const data = await client.getSessionGitStatus(sessionId, selected);
        if (seq !== seqRef.current) return; // 过期响应不得覆盖新目录/新请求
        setSnapshot(data);
        setSnapshotKey(`${sessionId}|${selected}`);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (seq !== seqRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        // 只有最新请求能落 latch：旧请求晚归不得误清，否则与下一次轮询叠出并发
        if (seq === seqRef.current) inFlightRef.current = false;
      }
    },
    [client, sessionId, selected],
  );

  // ── 轮询：选中目录变化即刷新一次；隐藏页签不轮询；pollSeconds=0 不自动轮询 ──
  useEffect(() => {
    if (!selected) return;
    setError(null); // 目录/会话切换后，旧目录的错误横幅不得挂在新数据上
    void refresh(true);
    if (pollSeconds <= 0) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh(false);
    }, pollSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [selected, pollSeconds, refresh]);

  useEffect(() => {
    const onVis = () => {
      // pollSeconds=0 = 不自动轮询：回前台也不自动拉（选中/切换目录与手动刷新除外）
      if (!document.hidden && pollSeconds > 0) void refresh(true);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh, pollSeconds]);

  if (!sessionId) {
    return <div className="small muted">请先打开会话。</div>;
  }

  const allRoots = roots ? [...roots.configured, ...roots.temporary] : [];
  // 只渲染属于当前「会话+选中目录」的快照；不与服务端回显路径做相等比较
  // （非规范根字符串经服务端 resolve 后会变样，导致永久加载中的假状态）
  const snap = snapshot && snapshotKey === `${sessionId}|${selected}` ? snapshot : null;
  const isClean =
    snap?.isRepo &&
    !snap.truncated &&
    snap.skippedRecords === 0 &&
    snap.counts.conflicted + snap.counts.staged + snap.counts.unstaged + snap.counts.untracked === 0;

  return (
    <section className="panel sidebar-section">
      <div className="sidebar-title" style={{ marginBottom: 8 }}>
        Git 状态
        <button
          type="button"
          className="btn-ghost small"
          disabled={!selected}
          onClick={() => void refresh(true)}
        >
          刷新
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <select
          className="model-select"
          style={{ flex: 1, minWidth: 0 }}
          value={selected ?? ''}
          onChange={(e) => setSelected(e.target.value || null)}
          disabled={allRoots.length === 0}
        >
          {allRoots.length === 0 && <option value="">（无可用目录）</option>}
          {roots && roots.configured.length > 0 && (
            <optgroup label="配置中的根">
              {roots.configured.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </optgroup>
          )}
          {roots && roots.temporary.length > 0 && (
            <optgroup label="会话临时根">
              {roots.temporary.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      {rootsError && (
        <div className="small status-error" style={{ marginBottom: 8 }}>
          目录加载失败：{rootsError}
        </div>
      )}
      {!rootsError && allRoots.length === 0 && roots && (
        <div className="small muted" style={{ marginBottom: 8 }}>
          当前 agent 无可选目录。可在「目录」页签为本会话追加临时根。
        </div>
      )}
      {error && (
        <div className="small status-error" style={{ marginBottom: 8 }}>
          刷新失败：{error}
          {snap ? '（下方为上次成功结果）' : ''}
        </div>
      )}

      {!snap && !error && !rootsError && selected && (
        <div className="small muted">加载中…</div>
      )}

      {snap && (
        <>
          <div style={{ marginBottom: 6 }}>
            <code
              className="small"
              style={{ display: 'block', wordBreak: 'break-all', opacity: 0.85 }}
            >
              {snap.repoRoot ?? snap.path}
            </code>
            {/* 独立 nowrap 行：任何瞬态文字与长路径并排都会触发 flex 重排、整列抖动 */}
            {updatedAt && (
              <div className="small muted" style={{ whiteSpace: 'nowrap' }}>
                更新于 {new Date(updatedAt).toLocaleTimeString()}
              </div>
            )}
          </div>

          {!snap.isRepo ? (
            <div className="small muted">不是 git 仓库（该目录及其父目录均无 .git）。</div>
          ) : (
            <>
              <div
                className="small"
                style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}
              >
                <span
                  className="small"
                  style={{
                    fontFamily: 'var(--font-mono, monospace)',
                    fontWeight: 500,
                    color: 'var(--color-text)',
                  }}
                >
                  {snap.branch ? branchLabel(snap.branch) : '(无分支信息)'}
                </span>
                <span className="small muted">
                  暂存 {snap.counts.staged} · 未暂存 {snap.counts.unstaged} · 未跟踪{' '}
                  {snap.counts.untracked} · 冲突 {snap.counts.conflicted}
                </span>
              </div>

              {isClean && (
                <div className="small status-ok">工作区干净</div>
              )}

              {GROUPS.map((g) => {
                const items = snap.entries.filter((e) => e.group === g.key);
                if (items.length === 0) return null;
                return (
                  <div key={g.key} style={{ marginBottom: 10 }}>
                    <div className="small muted" style={{ marginBottom: 4 }}>
                      {g.label}（{g.key === 'conflicted' ? snap.counts.conflicted : g.key === 'untracked' ? snap.counts.untracked : g.key === 'staged' ? snap.counts.staged : snap.counts.unstaged}）
                    </div>
                    <div style={{ display: 'grid', gap: 2 }}>
                      {items.map((e) => (
                        <div
                          key={`${e.group}:${e.origPath ?? ''}:${e.path}`}
                          style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}
                        >
                          <code
                            className="small"
                            style={{ color: g.color, fontWeight: 500, flexShrink: 0 }}
                          >
                            {xyCode(e)}
                          </code>
                          <code
                            className="small"
                            style={{ wordBreak: 'break-all', whiteSpace: 'normal' }}
                          >
                            {e.origPath ? `${e.origPath} → ${e.path}` : e.path}
                          </code>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}

              {snap.skippedRecords > 0 && (
                <div className="small status-warn">
                  {snap.skippedRecords} 条记录解析失败（git 输出格式可能已变），计数可能不完整。
                </div>
              )}

              {snap.truncated && (
                <div className="small muted">
                  条目过多，仅显示前 {snap.entries.length} 条（计数为全量）。
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
