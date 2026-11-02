/**
 * Knowledge Service 生命周期状态标记（自愈可见性，v0.98.14/15）
 *
 * 这是**状态指示器**，不是事件流装饰：mount 与 WS 重连时用 `/health` 的 `knowledge`
 * 状态 seed/覆盖（换页、网关重启后的旧红标都由 seed 纠偏），`knowledge.service.*`
 * WS 事件只作低延迟增量。`knowledge.required` 模式下服务缺席 = 全站拒 run，运维必须
 * 在控制台一眼看见（对齐 PRIVILEGED 常驻标记的「可见性标记」定位）：异常常驻显示，
 * `recovered` 绿条 5s 后归于零占位。不做告警通道：告警走 ops 观测面
 * （ops.knowledge.run_refused）。
 *
 * client prop 是**借用**：不接管其生命周期（卸载不 disconnect）；缺省自建 client
 * 由本组件负责 connect/disconnect。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  OctopiClient,
  type AgentEventEnvelope,
  type ConnectionState,
} from '@octopi-agent/gateway/web/sdk/client';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey } from '../console-key';

type LifecycleKind =
  | 'exited'
  | 'restarting'
  | 'restart_failed'
  | 'recovered'
  | 'seed_degraded'
  | 'seed_starting';

interface LifecycleState {
  kind: LifecycleKind;
  attempt?: number;
  backoffMs?: number;
  reason?: string;
  error?: string;
  code?: number | null;
  signal?: string | null;
}

const RECOVERED_VISIBLE_MS = 5_000;

/** restarting.reason 的英文枚举 → 中文（tooltip 用） */
const REASON_LABELS: Record<string, string> = {
  exited: '进程退出',
  boot_failed: '首启失败',
  restart_failed: '重启失败',
};

function pickLifecycle(event: { type: string; data?: unknown }): LifecycleState | null {
  const kind = event.type.replace(/^knowledge\.service\./, '') as LifecycleKind;
  if (!['exited', 'restarting', 'restart_failed', 'recovered'].includes(kind)) return null;
  const d = (event.data ?? {}) as {
    attempt?: number;
    backoffMs?: number;
    reason?: string;
    error?: string;
    code?: number | null;
    signal?: string | null;
  };
  return {
    kind,
    attempt: d.attempt,
    backoffMs: d.backoffMs,
    reason: d.reason,
    error: d.error,
    code: d.code,
    signal: d.signal,
  };
}

/** /health.knowledge → 标记状态（seed 语义：ready/disabled 清空，异常常驻） */
function pickSeed(state: string | undefined): LifecycleState | null {
  if (state === 'degraded') return { kind: 'seed_degraded' };
  if (state === 'starting') return { kind: 'seed_starting' };
  return null;
}

function describe(state: LifecycleState): { label: string; bg: string } {
  switch (state.kind) {
    case 'exited':
      return { label: '知识服务进程退出 · 自愈中', bg: '#c0392b' };
    case 'restarting':
      return {
        label: `知识服务重启中（第 ${state.attempt ?? '?'} 次${state.backoffMs != null ? `，退避 ${Math.round(state.backoffMs / 1000)}s` : ''}）`,
        bg: '#d35400',
      };
    case 'restart_failed':
      return {
        label: `知识服务重启失败（第 ${state.attempt ?? '?'} 次）· 继续退避重试`,
        bg: '#c0392b',
      };
    case 'recovered':
      return { label: '知识服务已恢复', bg: '#27ae60' };
    case 'seed_degraded':
      return { label: '知识服务不可用 · 自愈重试中', bg: '#c0392b' };
    case 'seed_starting':
      return { label: '知识服务启动中', bg: '#d35400' };
  }
}

function tooltip(state: LifecycleState): string {
  const parts: string[] = [];
  if (state.reason) parts.push(`触发=${REASON_LABELS[state.reason] ?? state.reason}`);
  if (state.error) parts.push(`error=${state.error}`);
  // OOM/被 kill 只能从 code/signal 看出来——崩溃唯一诊断信息不得丢
  if (state.kind === 'exited') parts.push(`code=${state.code ?? 'null'} signal=${state.signal ?? 'null'}`);
  return parts.length > 0 ? parts.join('；') : '知识服务子进程生命周期（自愈：指数退避自动重启）';
}

/** 常驻知识服务状态标记（app header 用；正常时零占位） */
export function KnowledgeServiceStatus({ client }: { client?: OctopiClient }) {
  // 所有权：只有自建 client 才由本组件 connect/disconnect；借用的不接管生命周期
  const owned = useMemo(
    () =>
      client ??
      new OctopiClient({ baseUrl: resolveDefaultBase(), apiKey: getConsoleKey() || undefined }),
    [client],
  );
  const owns = useRef(!client);
  const [state, setState] = useState<LifecycleState | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // seed/纠偏：换页、网关重启、WS 重连后以 /health 为准（事件不重放，seed 是唯一收敛点）
    const syncFromHealth = () => {
      void owned
        .health()
        .then((h) => {
          setState((prev) => {
            const seeded = pickSeed(h.knowledge);
            // seed 只在「异常」与「清空」间收敛；刚收到的瞬态 recovered 让它按时清
            if (!seeded) return prev?.kind === 'recovered' ? prev : null;
            return seeded;
          });
        })
        .catch(() => undefined);
    };
    owned.on({
      onEvent: (_sid: string | undefined, event: AgentEventEnvelope) => {
        const picked = pickLifecycle(event as unknown as { type: string; data?: unknown });
        if (!picked) return;
        if (clearTimer.current) {
          clearTimeout(clearTimer.current);
          clearTimer.current = null;
        }
        setState(picked);
        if (picked.kind === 'recovered') {
          clearTimer.current = setTimeout(() => setState(null), RECOVERED_VISIBLE_MS);
        }
      },
      onConnectionState: (s: ConnectionState) => {
        if (s === 'connected') syncFromHealth();
      },
    });
    owned.connect();
    syncFromHealth();
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
      if (owns.current) owned.disconnect();
    };
  }, [owned]);

  if (!state) return null;
  const { label, bg } = describe(state);
  return (
    <span
      title={tooltip(state)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 10px',
        borderRadius: 4,
        background: bg,
        color: '#fff',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.5,
      }}
    >
      {label}
    </span>
  );
}
