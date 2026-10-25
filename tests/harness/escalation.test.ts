/**
 * ops P3 白名单提权测试：全等匹配 / 二进制 TOCTOU 护栏 / priv_exec 契约 / 启动探测。
 * 规格：arch/ops-privileged-mode.md §5 P3 / §8.2 / §8.6。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  matchEscalationRule,
  resolveEffectiveEffectPolicy,
} from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';
import {
  checkEscalationBinary,
  escalationRuleTargets,
  probeEscalationReadiness,
  runPrivilegedExec,
  type EscalationPolicy,
} from '@octopi-agent/engine/harness/extension/execution-environment/privileged-exec.js';
import { createPrivExecTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/privileged-tool.js';
import { HitlDecisionCache } from '@octopi-agent/engine/harness/governance/human-in-the-loop/decision-cache.js';
import type { ToolExecutionContext } from '@octopi-agent/core/types/tools.js';

const tmp = mkdtempSync(join(tmpdir(), 'escalation-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const policy = (over?: Partial<EscalationPolicy>): EscalationPolicy => ({
  policy: 'allowlist',
  via: 'direct',
  allow: [],
  ...over,
});

describe('matchEscalationRule：全等匹配（§5 P3）', () => {
  const rules: EscalationPolicy = policy({
    allow: [
      { cmd: '/usr/bin/systemctl', args: ['restart', 'nginx'], confirm: true },
      { id: 'echo-ok', cmd: '/bin/echo', args: [] },
    ],
  });

  it('命中：cmd + args 逐项全等；ruleId 稳定（显式 id 优先）', () => {
    const hit = matchEscalationRule(rules, '/usr/bin/systemctl', ['restart', 'nginx']);
    expect(hit).not.toBeNull();
    expect(hit?.ruleId).toBe('allow[0]');
    expect(matchEscalationRule(rules, '/bin/echo', [])?.ruleId).toBe('echo-ok');
  });

  it('拒绝：少参/多参/换序/前缀/大小写差异', () => {
    expect(matchEscalationRule(rules, '/usr/bin/systemctl', ['restart'])).toBeNull();
    expect(matchEscalationRule(rules, '/usr/bin/systemctl', ['restart', 'nginx', '--force'])).toBeNull();
    expect(matchEscalationRule(rules, '/usr/bin/systemctl', ['nginx', 'restart'])).toBeNull();
    // 前缀/插值绝不算命中——否则 allowlist 即任意命令通道
    expect(matchEscalationRule(rules, '/usr/bin/systemctl', ['restart', 'nginx; rm -rf /'])).toBeNull();
    expect(matchEscalationRule(rules, '/usr/bin/Systemctl', ['restart', 'nginx'])).toBeNull();
  });

  it('policy=none 或未命中 → null（请求者另走 toolRights 闸，见 §8.6）', () => {
    expect(matchEscalationRule(policy({ policy: 'none' }), '/bin/echo', [])).toBeNull();
    expect(matchEscalationRule(rules, '/usr/bin/rm', ['-rf', '/'])).toBeNull();
  });
});

describe('escalationRuleTargets：有效目标是 sudo 之后的二进制（P0 修复）', () => {
  it('via: sudo 形态：必须显式 `sudo -n <绝对目标>`，护栏查到真实目标', () => {
    const good = escalationRuleTargets(
      { cmd: '/usr/bin/sudo', args: ['-n', '/usr/bin/systemctl', 'restart', 'nginx'] },
      'sudo',
    );
    expect('targets' in good && good.targets).toEqual(['/usr/bin/sudo', '/usr/bin/systemctl']);

    // 漏写 -n / 目标缺失或相对 → 形态非法（via 与事实脱节的组合被拒）
    expect(escalationRuleTargets({ cmd: '/usr/bin/sudo', args: ['systemctl'] }, 'sudo')).toMatchObject({
      invalid: expect.stringContaining('sudo -n'),
    });
    expect(escalationRuleTargets({ cmd: '/usr/bin/sudo', args: ['-n', 'systemctl'] }, 'sudo')).toMatchObject({
      invalid: expect.stringContaining('absolute'),
    });
  });

  it('via: sudo + 目标在可写面 → 护栏拒（此前只查 cmd，等于不查）', async () => {
    const writableTarget = join(tmp, 'payload');
    writeFileSync(writableTarget, '#!/bin/sh\n');
    const rule = { cmd: '/usr/bin/sudo', args: ['-n', writableTarget] };
    const targets = escalationRuleTargets(rule, 'sudo');
    expect('targets' in targets).toBe(true);
    if ('targets' in targets) {
      const checks = targets.targets.map((t) => checkEscalationBinary(t, [tmp]));
      expect(checks.some((c) => c !== null)).toBe(true);
    }
    const ready = await probeEscalationReadiness(
      policy({ via: 'sudo', allow: [rule] }),
      { writableRoots: [tmp] },
    );
    expect(ready.ok).toBe(false);
  });
});

describe('checkEscalationBinary：二进制不可换（TOCTOU 护栏）', () => {
  it('可写文件/可写父目录链被拒；root 态系统路径通过', () => {
    const writable = join(tmp, 'wbin');
    writeFileSync(writable, '#!/bin/sh\n');
    chmodSync(writable, 0o755);
    expect(checkEscalationBinary(writable, [])).toMatch(/writable/);

    // 可写目录 + rename 可换任意文件：0555 文件在可写父目录下同样被拒
    const sub = join(tmp, 'sub');
    mkdirSync(sub);
    const frozen = join(sub, 'frozen-bin');
    writeFileSync(frozen, '#!/bin/sh\n');
    chmodSync(frozen, 0o555);
    expect(checkEscalationBinary(frozen, [])).toMatch(/parent dir .*writable/);

    // /bin/echo：root 属主、文件与父目录链均不可写 → 通过（POSIX）
    if (process.platform !== 'win32') {
      expect(checkEscalationBinary('/bin/echo', [])).toBeNull();
    }
  });

  it('world/group 可写被拒；不存在但父目录链安全的路径放行（可后装）', () => {
    const ww = join(tmp, 'ww-bin');
    writeFileSync(ww, '#!/bin/sh\n');
    chmodSync(ww, 0o557);
    expect(checkEscalationBinary(ww, [])).toMatch(/writable/);
    if (process.platform !== 'win32') {
      expect(checkEscalationBinary('/usr/bin/not-yet-installed', [])).toBeNull();
    }
    expect(checkEscalationBinary('relative', [])).toMatch(/absolute/);
    // 可写面判定含前缀边界（/ws-x 不算 /ws 内）
    expect(checkEscalationBinary(join(tmp, 'x'), [join(tmp, 'other')])).not.toMatch(/inside agent-writable root .*other/);
  });
});

describe('resolve 校验矩阵（§4.1）', () => {
  it('allowlist 空规则 / 相对 cmd / 可写面内的 cmd → 拒绝；untrusted + escalation → 拒绝', () => {
    expect(() =>
      resolveEffectiveEffectPolicy({ mode: 'host', escalation: { policy: 'allowlist', allow: [] } }, '/ws'),
    ).toThrow(/allowlist requires/);
    expect(() =>
      resolveEffectiveEffectPolicy({ mode: 'host', escalation: { policy: 'allowlist', allow: [{ cmd: 'systemctl' }] } }, '/ws'),
    ).toThrow(/must be absolute/);

    const writableCmd = join(tmp, 'evil-bin');
    writeFileSync(writableCmd, '#!/bin/sh\n');
    expect(() =>
      resolveEffectiveEffectPolicy(
        { mode: 'host', escalation: { policy: 'allowlist', via: 'direct', allow: [{ cmd: writableCmd }] } },
        tmp,
      ),
    ).toThrow(/writable/);

    expect(() =>
      resolveEffectiveEffectPolicy(
        { mode: 'untrusted', escalation: { policy: 'allowlist', allow: [{ cmd: '/bin/echo' }] } },
        '/ws',
      ),
    ).toThrow(/untrusted/);
  });

  it('via=sudo 形态非法（漏写 -n/目标）→ 拒绝；escalation 缺省 none 不改 mode 语义', () => {
    expect(() =>
      resolveEffectiveEffectPolicy(
        { mode: 'host', escalation: { policy: 'allowlist', via: 'sudo', allow: [{ cmd: '/usr/bin/sudo', args: ['systemctl'] }] } },
        '/ws',
      ),
    ).toThrow(/sudo -n/);
    const eff = resolveEffectiveEffectPolicy({ mode: 'host' }, '/ws');
    expect(eff.escalation).toEqual({ policy: 'none', via: 'sudo', allow: [] });
    expect(eff.mode).toBe('host');
  });
});

describe('runPrivilegedExec：执行语义（spawn + 树杀）', () => {
  it('命令结束即树杀：后台子进程不留活口（D1 同语义）', async () => {
    const result = await runPrivilegedExec({
      cmd: '/bin/sh',
      args: ['-c', 'sleep 30 & echo $!'],
      via: 'direct',
      timeoutMs: 10_000,
    });
    expect(result.executed).toBe(true);
    expect(result.exitCode).toBe(0);
    const orphanPid = Number(result.stdout.trim());
    expect(Number.isInteger(orphanPid)).toBe(true);
    // 组杀后孤儿必须死（轮询容忍 zombie 重收窗口）
    let alive = true;
    for (let i = 0; i < 20 && alive; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        process.kill(orphanPid, 0);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it('spawn 从未成功（不存在的二进制）→ executed=false（≠ 执行失败）', async () => {
    const result = await runPrivilegedExec({
      cmd: join(tmp, 'definitely-missing'),
      args: [],
      via: 'direct',
      timeoutMs: 5000,
    });
    expect(result.executed).toBe(false);
    expect(result.exitCode).toBeNull();
  });
});

describe('probeEscalationReadiness：拿不到即拒绝（拍板 #5）', () => {
  it('policy=none → ok；allowlist 规则在可写面 → 拒；via=direct 非 root → 拒', async () => {
    expect(await probeEscalationReadiness(undefined)).toEqual({ ok: true });
    expect(await probeEscalationReadiness(policy({ policy: 'none' }))).toEqual({ ok: true });

    const badCmd = join(tmp, 'probe-evil');
    writeFileSync(badCmd, '#!/bin/sh\n');
    const rejected = await probeEscalationReadiness(policy({ allow: [{ cmd: badCmd }] }), {
      writableRoots: [tmp],
    });
    expect(rejected.ok).toBe(false);

    if (typeof process.geteuid === 'function' && process.geteuid() !== 0) {
      const direct = await probeEscalationReadiness(policy({ via: 'direct', allow: [{ cmd: '/bin/echo' }] }), {
        writableRoots: [],
      });
      expect(direct.ok).toBe(false);
      expect(direct.ok === false && direct.reason).toMatch(/geteuid/);
    }
  });
});

describe('priv_exec 工具契约（§5 P3 / §8.2）', () => {
  const tool = createPrivExecTool({ cache: new HitlDecisionCache() });
  const ctx = (over?: Partial<ToolExecutionContext>): ToolExecutionContext =>
    ({
      sessionId: 's1',
      agentId: 'a1',
      cwd: tmp,
      ...over,
    }) as ToolExecutionContext;

  it('policy=none → 拒绝 + ops.escalation.denied 留痕', async () => {
    const records: Array<{ event: string; data: Record<string, unknown> }> = [];
    await expect(
      tool.handler({ cmd: '/bin/echo' }, ctx({
        escalation: { policy: 'none', via: 'direct', allow: [] },
        recordOpsEvent: (r) => records.push(r),
      })),
    ).rejects.toThrow(/policy=none/);
    expect(records.at(-1)?.event).toBe('ops.escalation.denied');
    expect(records.at(-1)?.data.why).toBe('policy_none');
  });

  it('未命中/参数形态非法 → 拒绝 + 留痕（拒了没记 = 盲区）', async () => {
    const records: Array<{ event: string; data: Record<string, unknown> }> = [];
    await expect(
      tool.handler({ cmd: '/bin/echo', args: ['pwned'] }, ctx({
        escalation: policy({ allow: [{ cmd: '/bin/echo', args: ['ok'] }] }),
        recordOpsEvent: (r) => records.push(r),
      })),
    ).rejects.toThrow(/escalation_not_allowlisted/);
    await expect(
      tool.handler({ cmd: '/bin/echo', args: [1] }, ctx({
        escalation: policy({ allow: [{ cmd: '/bin/echo', args: ['ok'] }] }),
        recordOpsEvent: (r) => records.push(r),
      })),
    ).rejects.toThrow(/args must be/);
    expect(records.map((r) => r.data.why)).toEqual(['not_allowlisted', 'invalid_args']);
  });

  it('命中即执行：requested → privileged.exec 双账目、executed 语义、输出如实', async () => {
    const records: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = (await tool.handler({ cmd: '/bin/echo', args: ['hello-priv'] }, ctx({
      escalation: policy({ allow: [{ id: 'echo-hello', cmd: '/bin/echo', args: ['hello-priv'] }] }),
      recordOpsEvent: (r) => records.push(r),
    }))) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout).trim()).toBe('hello-priv');
    expect(result.confirmDecision).toBe('auto');
    expect(records.map((r) => r.event)).toEqual(['ops.escalation.requested', 'ops.privileged.exec']);
    const exec = records.at(-1)?.data ?? {};
    expect(exec.exitCode).toBe(0);
    expect(exec.executed).toBe(true);
    expect(exec.ruleId).toBe('echo-hello');
    expect(exec.origin).toMatchObject({ sessionId: 's1', agentId: 'a1' });
  });

  it('confirm 规则：deny → 拒 + 留痕；approve → 记 confirmDecision=approved', async () => {
    const records: Array<{ event: string; data: Record<string, unknown> }> = [];
    const rule = { cmd: '/bin/echo', args: ['need-confirm'], confirm: true };
    await expect(
      tool.handler({ cmd: '/bin/echo', args: ['need-confirm'] }, ctx({
        escalation: policy({ allow: [rule] }),
        confirmEffect: async () => 'deny',
        recordOpsEvent: (r) => records.push(r),
      })),
    ).rejects.toThrow(/escalation_confirm_denied/);
    expect(records.map((r) => r.event)).toEqual(['ops.escalation.requested', 'ops.escalation.denied']);
    expect(records.at(-1)?.data.why).toBe('confirm_denied');

    const ok = (await tool.handler({ cmd: '/bin/echo', args: ['need-confirm'] }, ctx({
      escalation: policy({ allow: [rule] }),
      confirmEffect: async () => 'approve',
      recordOpsEvent: (r) => records.push(r),
    }))) as Record<string, unknown>;
    expect(ok.confirmDecision).toBe('approved');
  });

  it('缓存 key 含 argv 全等 + 归属隔离：批 A 不放行 B，会话间不串', async () => {
    const cache = new HitlDecisionCache();
    const t = createPrivExecTool({ cache });
    const argA = ['cmd-A-cross'];
    const argB = ['cmd-B-cross'];
    let asks = 0;
    const confirmEffect = async () => {
      asks += 1;
      return asks === 1 ? 'approve_session' : 'deny';
    };
    const s1 = ctx({ sessionId: 's1', escalation: policy({ allow: [
      { cmd: '/bin/echo', args: argA, confirm: true },
      { cmd: '/bin/echo', args: argB, confirm: true },
    ] }), confirmEffect });
    const s2 = ctx({ sessionId: 's2', escalation: s1.escalation, confirmEffect });

    await t.handler({ cmd: '/bin/echo', args: argA }, s1);
    await t.handler({ cmd: '/bin/echo', args: argA }, s1); // 同 session 缓存命中，不再问
    expect(asks).toBe(1);
    // 跨会话不得继承批准（session 缓存按 sessionId 隔离）
    await expect(t.handler({ cmd: '/bin/echo', args: argA }, s2)).rejects.toThrow(/escalation_confirm_denied/);
    // 换 argv 必须重新问（argv 全等是缓存键的一部分）
    await expect(t.handler({ cmd: '/bin/echo', args: argB }, s1)).rejects.toThrow(/escalation_confirm_denied/);
    expect(asks).toBe(3);
  });

  it('approve_always 在特权通道降格为 approve_session（不留永久放行）', async () => {
    const cache = new HitlDecisionCache();
    const t = createPrivExecTool({ cache });
    const arg = ['always-does-not-stick'];
    let asks = 0;
    const context = ctx({
      escalation: policy({ allow: [{ cmd: '/bin/echo', args: arg, confirm: true }] }),
      confirmEffect: async () => {
        asks += 1;
        return asks === 1 ? 'approve_always' : 'deny';
      },
    });
    await t.handler({ cmd: '/bin/echo', args: arg }, context);
    // always 被降格 session 级：同 session 仍缓存生效（不重问），但绝不进 always 桶
    await t.handler({ cmd: '/bin/echo', args: arg }, context);
    expect(asks).toBe(1);
  });

  it('参数校验 fail-loud', async () => {
    await expect(tool.handler({}, ctx())).rejects.toThrow(/cmd/);
    await expect(tool.handler({ cmd: '' }, ctx())).rejects.toThrow(/cmd/);
    await expect(tool.handler({ cmd: '/bin/echo', args: 'not-array' }, ctx())).rejects.toThrow(/args/);
  });
});
