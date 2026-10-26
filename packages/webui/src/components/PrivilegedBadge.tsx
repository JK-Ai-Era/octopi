/**
 * 常驻 `PRIVILEGED` 标记（ops P4，`arch/ops-privileged-mode.md` §5 P4 / §8.1）
 *
 * 二级确认的另一半：配置侧 `privilegedAck`（强制表态）+ **常驻 UI 标记**（不是一次性
 * toast）。特权部署——`jail: none`（授权无笼）/ `escalation.policy: full`（全量提权）/
 * root·elevated 进程——时持续显示，任何人瞟一眼就知道这个 agent 跑在无笼/提权态。
 *
 * 数据源：`/api/v1/health` 的 `privileged` 块（gateway `getPrivilegedStatus()`：
 * 配置面 + 进程权限行为探测）。授权态 ≠ 降级：这是可见性标记，不是告警。
 */
import { useEffect, useMemo, useState } from 'react';
import { OctopiClient } from '@octopi-agent/gateway/web/sdk/client';
import { resolveDefaultBase } from '../gateway-base';

const POLL_INTERVAL_MS = 60_000;

/** 特权状态（与 gateway getPrivilegedStatus 返回同构） */
interface PrivilegedStatus {
  active: boolean;
  reasons: string[];
}

/** 常驻 PRIVILEGED 标记（app header 用） */
export function PrivilegedBadge() {
  const client = useMemo(() => new OctopiClient({ baseUrl: resolveDefaultBase() }), []);
  const [status, setStatus] = useState<PrivilegedStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void client
        .health()
        .then((h) => {
          if (alive) setStatus(h.privileged ?? null);
        })
        .catch(() => {
          // 网关不可达时保持上次已知状态：标记是可见性，不做假绿也不闪断
        });
    };
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client]);

  if (!status?.active) return null;
  return (
    <span
      title={`特权部署运行中（授权无笼 / 全量提权 / 高权限进程）：${status.reasons.join('；')}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 10px',
        borderRadius: 4,
        background: '#c0392b',
        color: '#fff',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1,
      }}
    >
      PRIVILEGED
    </span>
  );
}
