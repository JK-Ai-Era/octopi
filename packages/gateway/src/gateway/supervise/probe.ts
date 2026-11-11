/**
 * supervise/probe — 健康门（arch/service-topology-p0c.md §4.3，§5.2 probe(instance)）。
 *
 * 检查链：① boot + ready 握手（spawn 时已过）→ ② `GET /health` 契约面可达 →
 * ③ 冒烟 `POST /smoke` 通过（Q2 已拍板：含冒烟）→ ④ 守卫在位核查（配置含
 * securityIntegrity 而实例报 absent → 拒——收口跨版本漂移闸 fail-open 缺口）。
 *
 * 任一失败 = 健康门拒（调用方处置：不入路由 / 移出路由）。
 *
 * @module gateway/supervise/probe
 */

import type { InstanceBackend } from './fleet-backend.js';

export interface ProbeCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ProbeResult {
  ok: boolean;
  checks: ProbeCheck[];
}

export interface ProbeOptions {
  /** gateway 侧配置是否含 securityIntegrity 守卫（配置锚定面） */
  securityIntegrityConfigured: boolean;
}

/**
 * 健康门探测（幂等；fail-loud 到 checks 明细，不抛——结果由调用方裁决）。
 *
 * @param backend - 实例执行面
 * @param options - 探测选项
 * @returns 探测结果（逐项 checks）
 */
export async function probeInstance(
  backend: InstanceBackend,
  options: ProbeOptions,
): Promise<ProbeResult> {
  const checks: ProbeCheck[] = [];

  // ② health 契约面可达（不可达即拒——后两项无从谈起）
  let health: Awaited<ReturnType<InstanceBackend['health']>> | undefined;
  try {
    health = await backend.health();
    checks.push({ name: 'health', ok: true });
  } catch (err) {
    checks.push({
      name: 'health',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, checks };
  }

  // ③ 冒烟（装配热路径 + no-LLM 应答；Q2 拍板含冒烟）
  try {
    const report = await backend.smoke();
    checks.push(
      report.ok
        ? { name: 'smoke', ok: true }
        : {
            name: 'smoke',
            ok: false,
            detail: JSON.stringify(report.agents.map((a) => ({ agentId: a.agentId, checks: a.checks }))),
          },
    );
  } catch (err) {
    checks.push({
      name: 'smoke',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ④ 守卫在位核查（跨版本缺口收口：旧版实例不按 configPath 自建守卫 = 无声 fail-open）
  const guard = health.securityGuard ?? 'absent';
  if (options.securityIntegrityConfigured && guard !== 'armed') {
    checks.push({
      name: 'securityGuard',
      ok: false,
      detail: 'config has securityIntegrity but instance guard is absent (cross-version fail-open)',
    });
  } else {
    checks.push({ name: 'securityGuard', ok: true, detail: guard });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
