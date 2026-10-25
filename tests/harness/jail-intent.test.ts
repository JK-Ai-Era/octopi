/**
 * ops P0（OP-OPS-1）：jail 意图矩阵 ——「授权」与「故障」必须可分辨。
 * 规格：arch/ops-privileged-mode.md §4 / §9。
 */
import { describe, it, expect } from 'vitest';

import {
  resolveEffectiveEffectPolicy,
  requiresJail,
  buildOpsJailState,
} from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';
import {
  supervisedSpawnProfile,
  type ProcessIsolationProfile,
} from '@octopi-agent/engine/harness/extension/execution-environment/process-isolation.js';
import { EffectPolicyConfigSchema } from '@octopi-agent/engine/config-schema/governance.js';

const jailOk: ProcessIsolationProfile = {
  backend: 'mac-seatbelt',
  processTree: 'killable',
  filesystem: 'write-jailed',
  resources: 'best-effort',
  network: 'deny',
  privilege: 'dropped',
  envHygiene: 'scrubbed',
  notes: [],
};

const noJail = supervisedSpawnProfile();

describe('jail intent: probe 期缺笼不得静默（P0 核心断言）', () => {
  it('host + jail:auto + 无笼 → run 级 no_process_jail（不再只有 untrusted 申报）', () => {
    const eff = resolveEffectiveEffectPolicy({ mode: 'host' }, '/ws', noJail);
    expect(eff.securityDegraded).toContain('no_process_jail');
  });

  it('host + jail:auto + onJailUnavailable:refuse + 无笼 → 拒绝（抛 jail_required_unavailable）', () => {
    expect(() =>
      resolveEffectiveEffectPolicy(
        { mode: 'host', jail: 'auto', onJailUnavailable: 'refuse' },
        '/ws',
        noJail,
      ),
    ).toThrow(/jail_required_unavailable/);
  });

  it('jail:require + 无笼 → host 也 fail-closed', () => {
    expect(() =>
      resolveEffectiveEffectPolicy({ mode: 'host', jail: 'require' }, '/ws', noJail),
    ).toThrow(/jail_required_unavailable/);
  });

  it('jail:require + 有笼 → 不抛，requiresJail=true', () => {
    const eff = resolveEffectiveEffectPolicy({ mode: 'host', jail: 'require' }, '/ws', jailOk);
    expect(requiresJail(eff)).toBe(true);
    expect(eff.securityDegraded).not.toContain('no_process_jail');
  });
});

describe('jail:none = 授权，不是降级', () => {
  it('缺 privilegedAck → 配置矛盾拒绝', () => {
    expect(() => resolveEffectiveEffectPolicy({ mode: 'host', jail: 'none' }, '/ws', jailOk)).toThrow(
      /privilegedAck/,
    );
  });

  it('配了 privilegedAck → securityDegraded 为空、requiresJail=false', () => {
    const eff = resolveEffectiveEffectPolicy(
      { mode: 'host', jail: 'none', privilegedAck: 'unjailed-by-choice' },
      '/ws',
      noJail,
    );
    expect(eff.jail).toBe('none');
    expect(eff.securityDegraded).not.toContain('no_process_jail');
    expect(requiresJail(eff)).toBe(false);
  });

  it('jail:none + onJailUnavailable:refuse → 死键 fail-loud 拒绝（不静默忽略）', () => {
    expect(() =>
      resolveEffectiveEffectPolicy(
        { mode: 'host', jail: 'none', onJailUnavailable: 'refuse', privilegedAck: 'ok' },
        '/ws',
        noJail,
      ),
    ).toThrow(/no meaning/);
  });

  it('jail:none + 显式 network=deny → 拒绝（无执行机制的假承诺）；未指定 → 如实 open', () => {
    expect(() =>
      resolveEffectiveEffectPolicy(
        { mode: 'host', jail: 'none', network: 'deny', privilegedAck: 'ok' },
        '/ws',
        noJail,
      ),
    ).toThrow(/cannot be enforced/);
    const eff = resolveEffectiveEffectPolicy(
      { mode: 'host', jail: 'none', privilegedAck: 'ok' },
      '/ws',
      noJail,
    );
    expect(eff.network).toBe('open');
  });

  it('jail:none 在 workspace/project 下同样成立（授权无笼不挑 mode）', () => {
    for (const mode of ['workspace', 'project'] as const) {
      const eff = resolveEffectiveEffectPolicy(
        { mode, jail: 'none', privilegedAck: 'ok' },
        '/ws',
        noJail,
      );
      expect(eff.jail).toBe('none');
      expect(eff.securityDegraded).not.toContain('no_process_jail');
      expect(requiresJail(eff)).toBe(false);
    }
  });

  it('untrusted + jail=require + 无笼 → jail_required_unavailable（不是 untrusted_refused）', () => {
    expect(() =>
      resolveEffectiveEffectPolicy({ mode: 'untrusted', jail: 'require' }, '/ws', noJail),
    ).toThrow(/jail_required_unavailable/);
  });

  it('onJailUnavailable:refuse + untrustedAdmission:degrade → 矛盾拒绝（同条件反结局）', () => {
    expect(() =>
      resolveEffectiveEffectPolicy(
        { mode: 'untrusted', onJailUnavailable: 'refuse', untrustedAdmission: 'degrade' },
        '/ws',
        noJail,
      ),
    ).toThrow(/contradicts/);
  });

  it('jail:none + mode=untrusted → 配置矛盾拒绝（untrusted 承诺有笼）', () => {
    expect(() =>
      resolveEffectiveEffectPolicy(
        { mode: 'untrusted', jail: 'none', privilegedAck: 'x' },
        '/ws',
        jailOk,
      ),
    ).toThrow(/untrusted/);
  });

  it('jail=require 与 untrustedAdmission=degrade 矛盾 → 拒绝', () => {
    expect(() =>
      resolveEffectiveEffectPolicy(
        { mode: 'untrusted', jail: 'require', untrustedAdmission: 'degrade' },
        '/ws',
        jailOk,
      ),
    ).toThrow(/contradicts/);
  });
});

describe('ops.jail.state：意图 × 实测后端（授权 vs 故障判据）', () => {
  it('授权无笼：intent=none → authorized=true', () => {
    const eff = resolveEffectiveEffectPolicy(
      { mode: 'host', jail: 'none', privilegedAck: 'ok' },
      '/ws',
      noJail,
    );
    const state = buildOpsJailState(eff, noJail);
    expect(state).toMatchObject({ intent: 'none', authorized: true, jailAvailable: false });
  });

  it('故障缺笼：auto + 无笼 → authorized=false 且 degraded 含 no_process_jail', () => {
    const eff = resolveEffectiveEffectPolicy({ mode: 'host' }, '/ws', noJail);
    const state = buildOpsJailState(eff, noJail);
    expect(state.authorized).toBe(false);
    expect(state.degraded).toContain('no_process_jail');
    expect(state.backend).toBe(noJail.backend);
  });

  it('笼按意图就位：authorized=true', () => {
    const eff = resolveEffectiveEffectPolicy({ mode: 'host' }, '/ws', jailOk);
    expect(buildOpsJailState(eff, jailOk)).toMatchObject({ authorized: true, jailAvailable: true });
  });
});

describe('配置 schema 交叉校验（拒绝启动语义）', () => {
  it('jail=none 无 ack 被 schema 拒绝；有 ack 通过', () => {
    expect(EffectPolicyConfigSchema.safeParse({ jail: 'none' }).success).toBe(false);
    expect(
      EffectPolicyConfigSchema.safeParse({ jail: 'none', privilegedAck: 'ok' }).success,
    ).toBe(true);
  });

  it('jail=none + untrusted 被 schema 拒绝；jail=require + untrustedAdmission=degrade 被拒绝', () => {
    expect(
      EffectPolicyConfigSchema.safeParse({ mode: 'untrusted', jail: 'none', privilegedAck: 'x' })
        .success,
    ).toBe(false);
    expect(
      EffectPolicyConfigSchema.safeParse({ jail: 'require', untrustedAdmission: 'degrade' }).success,
    ).toBe(false);
  });

  it('死键/矛盾组合被 schema 拒绝：none+refuse、refuse+degrade', () => {
    expect(
      EffectPolicyConfigSchema.safeParse({ jail: 'none', privilegedAck: 'x', onJailUnavailable: 'refuse' }).success,
    ).toBe(false);
    expect(
      EffectPolicyConfigSchema.safeParse({ onJailUnavailable: 'refuse', untrustedAdmission: 'degrade' }).success,
    ).toBe(false);
  });
});

describe('sandbox 授权无笼注记（jail=disabled_by_config）', () => {
  it('disableJail：即便有笼后端也不包裹，注记 disabled_by_config 且非降级', async () => {
    const { ProcessSandbox } = await import(
      '@octopi-agent/engine/harness/extension/execution-environment/sandbox.js'
    );
    const sb = new ProcessSandbox({ profile: jailOk });
    const result = await sb.execute('echo hi', {
      disableJail: true,
      limits: { timeoutMs: 5000 },
    });
    expect(result.isolation.backend).toBe('supervised-spawn');
    expect(result.isolation.notes?.join('\n')).toContain('jail=disabled_by_config (privileged)');
  });

  it('disableJail × requireJail 矛盾：库契约守卫拒绝（不静默取舍）', async () => {
    const { ProcessSandbox } = await import(
      '@octopi-agent/engine/harness/extension/execution-environment/sandbox.js'
    );
    const sb = new ProcessSandbox({ profile: jailOk });
    await expect(
      sb.execute('echo hi', { disableJail: true, requireJail: true, limits: { timeoutMs: 5000 } }),
    ).rejects.toThrow(/sandbox_config_conflict/);
  });

  it('失笼归一码契约：jailDegradationCode 前缀覆盖全部失笼路径', async () => {
    const { jailDegradationCode } = await import(
      '@octopi-agent/engine/harness/extension/execution-environment/sandbox.js'
    );
    // 消费面按 no_process_jail 前缀匹配即可覆盖 probe 缺笼 + 两类运行时失笼
    expect(jailDegradationCode('jail_setup_failed: x')).toBe('no_process_jail: jail_setup_failed: x');
    expect(jailDegradationCode('jail_spawn_failed: y').startsWith('no_process_jail')).toBe(true);
  });

  it('缺笼回落：注记 jail=unavailable（逐条命令如实申报）', async () => {
    const { ProcessSandbox } = await import(
      '@octopi-agent/engine/harness/extension/execution-environment/sandbox.js'
    );
    const sb = new ProcessSandbox({ profile: noJail });
    const result = await sb.execute('echo hi', { limits: { timeoutMs: 5000 } });
    expect(result.isolation.notes?.join('\n')).toContain('jail=unavailable (supervised-spawn)');
  });
});
