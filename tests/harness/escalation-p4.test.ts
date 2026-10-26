/**
 * ops P4 全量档测试：§4.1 矛盾校验 / §5 P4 root 声明 / §6 危险分类减速带 / full 档 priv_exec。
 * 规格：arch/ops-privileged-mode.md §4.1 / §5 P4 / §6 / §8。
 */
import { describe, it, expect } from 'vitest';

import {
  resolveEffectiveEffectPolicy,
} from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';
import {
  assertPrivilegedDeclaration,
  isProcessElevated,
  isProcessElevatedSync,
  probeEscalationReadiness,
  type EscalationPolicy,
} from '@octopi-agent/engine/harness/extension/execution-environment/privileged-exec.js';
import { classifyDangerousArgv } from '@octopi-agent/engine/harness/extension/execution-environment/dangerous-commands.js';
import { createPrivExecTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/privileged-tool.js';
import { HitlDecisionCache } from '@octopi-agent/engine/harness/governance/human-in-the-loop/decision-cache.js';
import { EffectPolicyConfigSchema } from '@octopi-agent/engine/config-schema/governance.js';
import type { ToolExecutionContext } from '@octopi-agent/core/types/tools.js';

const fullPolicy = (over?: Partial<EscalationPolicy>): EscalationPolicy => ({
  policy: 'full',
  via: 'direct',
  allow: [],
  ...over,
});

const fullBase = {
  mode: 'host' as const,
  jail: 'none' as const,
  privilegedAck: 'unjailed-by-choice',
  escalation: { policy: 'full' as const, via: 'direct' as const },
};

describe('§4.1 full 档矛盾校验（fail-closed，拒绝启动）', () => {
  it('合法 full：mode=host + jail=none + privilegedAck → resolve 通过，privileged=true', () => {
    const eff = resolveEffectiveEffectPolicy(fullBase);
    expect(eff.escalation.policy).toBe('full');
    expect(eff.privileged).toBe(true);
    // 授权无笼不是降级：securityDegraded 必须为空
    expect(eff.securityDegraded).toEqual([]);
  });

  it('full + jail≠none → 矛盾拒绝（allowlist 档不矛盾，断言可共存）', () => {
    expect(() =>
      resolveEffectiveEffectPolicy({ ...fullBase, jail: 'auto' }),
    ).toThrow(/full requires jail=none/);
    expect(() =>
      resolveEffectiveEffectPolicy({ ...fullBase, jail: 'require' }),
    ).toThrow(/full requires jail=none/);
    // allowlist + jail=auto 共存（原则 6：提权不与牢笼抢轴）
    const allowlistEff = resolveEffectiveEffectPolicy({
      mode: 'host',
      jail: 'auto',
      escalation: {
        policy: 'allowlist',
        via: 'direct',
        allow: [{ cmd: '/bin/echo', args: ['ok'] }],
      },
    });
    expect(allowlistEff.escalation.policy).toBe('allowlist');
    expect(allowlistEff.privileged).toBe(false);
  });

  it('full 缺 privilegedAck / mode≠host → 拒绝；full 带 allow 规则 = 死键拒绝', () => {
    expect(() =>
      resolveEffectiveEffectPolicy({ ...fullBase, privilegedAck: undefined }),
    ).toThrow(/full requires effectPolicy.privilegedAck/);
    expect(() =>
      resolveEffectiveEffectPolicy({ ...fullBase, mode: 'project' }),
    ).toThrow(/full requires mode=host/);
    expect(() =>
      resolveEffectiveEffectPolicy({ ...fullBase, mode: undefined }),
    ).toThrow(/full requires mode=host/);
    expect(() =>
      resolveEffectiveEffectPolicy({
        ...fullBase,
        escalation: { policy: 'full', via: 'direct', allow: [{ cmd: '/bin/echo' }] },
      }),
    ).toThrow(/takes no escalation.allow rules/);
  });

  it('schema superRefine 同口径拒绝（配置面先于启动探测）', () => {
    expect(
      EffectPolicyConfigSchema.safeParse({
        mode: 'host',
        jail: 'auto',
        privilegedAck: 'x',
        escalation: { policy: 'full' },
      }).success,
    ).toBe(false);
    expect(
      EffectPolicyConfigSchema.safeParse({
        mode: 'host',
        jail: 'none',
        escalation: { policy: 'full' },
      }).success,
    ).toBe(false);
    expect(
      EffectPolicyConfigSchema.safeParse({
        mode: 'host',
        jail: 'none',
        privilegedAck: 'x',
        escalation: { policy: 'full', allow: [{ cmd: '/bin/echo' }] },
      }).success,
    ).toBe(false);
    expect(
      EffectPolicyConfigSchema.safeParse({
        mode: 'host',
        jail: 'none',
        privilegedAck: 'x',
        escalation: { policy: 'full' },
      }).success,
    ).toBe(true);
    // allowlist 档与 jail=auto 不矛盾
    expect(
      EffectPolicyConfigSchema.safeParse({
        mode: 'host',
        jail: 'auto',
        escalation: { policy: 'allowlist', allow: [{ cmd: '/bin/echo' }] },
      }).success,
    ).toBe(true);
  });

  it('dangerousCommands resolved 缺省（confirm / 120s），显式配置透传', () => {
    const eff = resolveEffectiveEffectPolicy(fullBase);
    expect(eff.dangerousCommands).toEqual({ policy: 'confirm', timeoutMs: 120_000 });
    const eff2 = resolveEffectiveEffectPolicy({
      ...fullBase,
      dangerousCommands: { policy: 'deny', timeoutMs: 5_000 },
    });
    expect(eff2.dangerousCommands).toEqual({ policy: 'deny', timeoutMs: 5_000 });
  });
});

describe('§5 P4 root 部署语义：显式 privileged 声明', () => {
  it('elevated 且无 privilegedAck → 拒绝；有 ack / 非 elevated → 通过', () => {
    expect(() =>
      assertPrivilegedDeclaration({ elevated: true, scope: '<top>' }),
    ).toThrow(/privileged_declaration_required/);
    expect(() =>
      assertPrivilegedDeclaration({ elevated: true, privilegedAck: '  ', scope: 'a1' }),
    ).toThrow(/privileged_declaration_required/);
    expect(() =>
      assertPrivilegedDeclaration({ elevated: true, privilegedAck: 'root-by-design', scope: '<top>' }),
    ).not.toThrow();
    expect(() =>
      assertPrivilegedDeclaration({ elevated: false, scope: '<top>' }),
    ).not.toThrow();
  });

  it('isProcessElevated 与 geteuid 同口径（POSIX 同步面），win32 同步面如实不判', async () => {
    const elevated = await isProcessElevated();
    if (process.platform === 'win32') {
      expect(isProcessElevatedSync()).toBe(false);
    } else if (typeof process.geteuid === 'function') {
      expect(elevated).toBe(process.geteuid() === 0);
      expect(isProcessElevatedSync()).toBe(elevated);
    }
  });
});

describe('§6 危险命令分类（减速带，不是安全边界）', () => {
  it('命中表逐条命中；同类非危险形态不命中', () => {
    expect(classifyDangerousArgv(['/bin/rm', '-rf', '/'])).toMatchObject({ dangerous: true, pattern: 'rm -rf' });
    expect(classifyDangerousArgv(['/bin/rm', '-r', '-f', 'x'])).toMatchObject({ dangerous: true });
    expect(classifyDangerousArgv(['/bin/rm', '--recursive', '--force', 'x'])).toMatchObject({ dangerous: true });
    expect(classifyDangerousArgv(['/bin/dd', 'if=/dev/zero', 'of=/dev/sda'])).toMatchObject({ dangerous: true, pattern: 'dd of=/dev/*' });
    expect(classifyDangerousArgv(['/sbin/mkfs.ext4', '/dev/sdb1'])).toMatchObject({ dangerous: true, pattern: 'mkfs.*' });
    expect(classifyDangerousArgv(['/usr/sbin/iptables', '-F'])).toMatchObject({ dangerous: true, pattern: 'iptables -F' });
    expect(classifyDangerousArgv(['/bin/systemctl', 'disable', 'nginx'])).toMatchObject({ dangerous: true, pattern: 'systemctl disable' });
    expect(classifyDangerousArgv(['/bin/chmod', '-R', '777', '/'])).toMatchObject({ dangerous: true, pattern: 'chmod -R' });
    expect(classifyDangerousArgv(['/usr/sbin/chown', '-R', 'a:b', '/x'])).toMatchObject({ dangerous: true, pattern: 'chown -R' });
    expect(classifyDangerousArgv(['/usr/bin/truncate', '-s', '0', '/etc/passwd'])).toMatchObject({ dangerous: true, pattern: 'truncate' });

    // 未命中放行（不做「未知即危险」）
    expect(classifyDangerousArgv(['/bin/rm', 'a.txt']).dangerous).toBe(false);
    expect(classifyDangerousArgv(['/bin/dd', 'if=/dev/zero', 'of=/tmp/x.img']).dangerous).toBe(false);
    expect(classifyDangerousArgv(['/bin/systemctl', 'restart', 'nginx']).dangerous).toBe(false);
    expect(classifyDangerousArgv(['/bin/chmod', '644', 'a.txt']).dangerous).toBe(false);
  });

  it('提权前缀剥离后分类（sudo -n rm -rf 同 rm -rf）', () => {
    expect(classifyDangerousArgv(['/usr/bin/sudo', '-n', '/bin/rm', '-rf', '/'])).toMatchObject({
      dangerous: true,
      pattern: 'rm -rf',
    });
    expect(classifyDangerousArgv(['/usr/bin/sudo', '-n', '-u', 'postgres', '/bin/psql'])).toMatchObject({
      dangerous: false,
    });
  });

  it('已知绕过（钉局限，防后人误当边界）：sh -c 的命令串不解析；重定向 argv 表达不了', () => {
    // 分类只看 argv 表层——嵌套 shell / 重定向绕过是已知局限，不是漏洞回归
    expect(classifyDangerousArgv(['/bin/sh', '-c', 'rm -rf /']).dangerous).toBe(false);
    expect(classifyDangerousArgv(['/bin/bash', '-c', 'dd of=/dev/sda if=/dev/zero']).dangerous).toBe(false);
  });
});

describe('priv_exec full 档（P4）', () => {
  const tool = createPrivExecTool({ cache: new HitlDecisionCache() });
  const ctx = (over?: Partial<ToolExecutionContext>): ToolExecutionContext =>
    ({
      sessionId: 's1',
      agentId: 'a1',
      cwd: '/tmp',
      ...over,
    }) as ToolExecutionContext;

  it('via:direct 任意绝对 argv 执行（ruleId=full）；非危险不进确认闸', async () => {
    const records: Array<{ event: string; data: Record<string, unknown> }> = [];
    let asks = 0;
    const result = (await tool.handler({ cmd: '/bin/echo', args: ['full-mode'] }, ctx({
      escalation: fullPolicy(),
      confirmEffect: async () => {
        asks += 1;
        return 'deny';
      },
      recordOpsEvent: (r) => records.push(r),
    }))) as Record<string, unknown>;
    expect(result.ruleId).toBe('full');
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout).trim()).toBe('full-mode');
    // §6：非危险未命中放行，连确认都不问（减速带定位）
    expect(asks).toBe(0);
    expect(records.map((r) => r.event)).toEqual(['ops.escalation.requested', 'ops.privileged.exec']);
  });

  it('形态守卫：相对 cmd / via=sudo 未显式 `sudo -n` → 拒 + invalid_args 留痕', async () => {
    const records: Array<{ event: string; data: Record<string, unknown> }> = [];
    await expect(
      tool.handler({ cmd: 'echo', args: ['x'] }, ctx({
        escalation: fullPolicy(),
        recordOpsEvent: (r) => records.push(r),
      })),
    ).rejects.toThrow(/absolute path/);
    await expect(
      tool.handler({ cmd: '/usr/bin/sudo', args: ['systemctl', 'restart', 'nginx'] }, ctx({
        escalation: fullPolicy({ via: 'sudo' }),
        recordOpsEvent: (r) => records.push(r),
      })),
    ).rejects.toThrow(/sudo -n/);
    expect(records.map((r) => r.data.why)).toEqual(['invalid_args', 'invalid_args']);
  });

  it('危险命中 + policy=deny → 直接拒；policy=confirm → 走闸门（approve 执行 / deny 拒）', async () => {
    const denied: Array<{ event: string; data: Record<string, unknown> }> = [];
    await expect(
      tool.handler({ cmd: '/bin/rm', args: ['-rf', '/tmp/nope'] }, ctx({
        escalation: fullPolicy(),
        dangerousCommands: { policy: 'deny', timeoutMs: 5_000 },
        recordOpsEvent: (r) => denied.push(r),
      })),
    ).rejects.toThrow(/escalation_dangerous_denied/);
    expect(denied.at(-1)?.data).toMatchObject({ why: 'dangerous_denied', dangerous: 'rm -rf' });

    const records: Array<{ event: string; data: Record<string, unknown> }> = [];
    const confirm = { asks: 0, decisions: ['deny', 'approve'] as Array<'deny' | 'approve'> };
    const confirmEffect = async () => {
      confirm.asks += 1;
      return confirm.decisions[confirm.asks - 1] ?? 'deny';
    };
    await expect(
      tool.handler({ cmd: '/bin/rm', args: ['-rf', '/tmp/nope'] }, ctx({
        escalation: fullPolicy(),
        dangerousCommands: { policy: 'confirm', timeoutMs: 5_000 },
        confirmEffect,
        recordOpsEvent: (r) => records.push(r),
      })),
    ).rejects.toThrow(/escalation_confirm_denied/);
    expect(records.at(-1)?.data).toMatchObject({ why: 'confirm_denied', dangerous: 'rm -rf' });

    const ok = (await tool.handler({ cmd: '/bin/rm', args: ['-rf', '/tmp/nope2'] }, ctx({
      escalation: fullPolicy(),
      dangerousCommands: { policy: 'confirm', timeoutMs: 5_000 },
      confirmEffect,
      recordOpsEvent: (r) => records.push(r),
    }))) as Record<string, unknown>;
    expect(ok.confirmDecision).toBe('approved');
    expect(ok.ruleId).toBe('full');
  });

  it('确认超时 → deny（T1 硬约束，outcome 不可配）：confirm_timeout 留痕', async () => {
    const cache = new HitlDecisionCache();
    const t = createPrivExecTool({ cache });
    const records: Array<{ event: string; data: Record<string, unknown> }> = [];
    await expect(
      t.handler({ cmd: '/bin/rm', args: ['-rf', '/tmp/timeout-case'] }, ctx({
        escalation: fullPolicy(),
        dangerousCommands: { policy: 'confirm', timeoutMs: 50 },
        // 宿主永不作答（异步确认通道吊住）——超时必须自行 deny
        confirmEffect: () => new Promise(() => {}),
        recordOpsEvent: (r) => records.push(r),
      })),
    ).rejects.toThrow(/escalation_confirm_timeout/);
    expect(records.at(-1)?.data).toMatchObject({ why: 'confirm_timeout', dangerous: 'rm -rf' });
  });
});

describe('probeEscalationReadiness：full 档（P4）', () => {
  it('full 无 allowlist 面：空 allow 进探测，带 allow 规则 → 拒', async () => {
    const withRules = await probeEscalationReadiness(fullPolicy({ allow: [{ cmd: '/bin/echo' }] }));
    expect(withRules.ok).toBe(false);
    expect(withRules.ok === false && withRules.reason).toMatch(/takes no escalation.allow rules/);

    if (typeof process.geteuid === 'function' && process.geteuid() !== 0) {
      const direct = await probeEscalationReadiness(fullPolicy());
      expect(direct.ok).toBe(false);
      expect(direct.ok === false && direct.reason).toMatch(/geteuid/);
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'Windows：未 elevated + escalation 声明 → 拒启（真机断言，勿 mock）',
    async () => {
      const probe = await probeEscalationReadiness(fullPolicy({ via: 'direct' }));
      const elevated = await isProcessElevated();
      if (elevated) {
        expect(probe.ok).toBe(true);
      } else {
        expect(probe.ok).toBe(false);
        expect(probe.ok === false && probe.reason).toMatch(/elevated/);
      }
    },
  );
});
