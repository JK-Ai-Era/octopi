/**
 * ToolEffectPolicy P3 — 运行模式展开 + L2 路径包含
 */
import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';

import {
  resolveEffectiveEffectPolicy,
  requiresJail,
  isPathAllowed,
  isToolAllowedOnSurface,
} from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';
import {
  resolveToolPath,
  isPathUnderRoots,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/platform.js';

describe('resolveEffectiveEffectPolicy', () => {
  it('omitted mode defaults to workspace (engine secure-by-default)', () => {
    const p = resolveEffectiveEffectPolicy({}, '/home/user');
    expect(p.mode).toBe('workspace');
    expect(p.requestedMode).toBe('workspace');
    expect(p.shellEscape).toBe('deny');
    expect(p.pathContainment).toBe('strict');
    expect(p.toolIsolation).toBe('session-subdir');
  });

  it('explicit host keeps full capability (scaffold / local evaluation)', () => {
    const p = resolveEffectiveEffectPolicy({ mode: 'host' }, '/home/user');
    expect(p.mode).toBe('host');
    expect(p.shellEscape).toBe('allow');
    expect(p.pathContainment).toBe('none');
  });

  it('workspace mode: strict containment + shell deny (fail-closed until L4)', () => {
    const p = resolveEffectiveEffectPolicy({ mode: 'workspace' }, '/work/ws');
    expect(p.pathContainment).toBe('strict');
    // 无 L4 无法只禁越界：deny = 拒绝 shell，保策略语义
    expect(p.shellEscape).toBe('deny');
    expect(p.toolIsolation).toBe('session-subdir');
    expect(p.commit).toBe('auto');
    expect(p.allowRoots).toContain('/work/ws');
  });

  it('project mode: shell allow for coding agents (file L2 still strict)', () => {
    const p = resolveEffectiveEffectPolicy({ mode: 'project' }, '/repo');
    expect(p.pathContainment).toBe('strict');
    expect(p.shellEscape).toBe('allow');
  });

  it('host mode: no path jail, shell allowed', () => {
    const p = resolveEffectiveEffectPolicy({ mode: 'host' }, '/home/user');
    expect(p.pathContainment).toBe('none');
    expect(p.shellEscape).toBe('allow');
    expect(p.toolIsolation).toBe('none');
  });

  it('untrusted: refuses without L4 process jail (default admission)', () => {
    expect(() =>
      resolveEffectiveEffectPolicy({ mode: 'untrusted' }, '/sandbox'),
    ).toThrow(/untrusted_refused/);
  });

  it('untrusted + L4 profile: keeps untrusted mode and full surface', () => {
    const p = resolveEffectiveEffectPolicy({ mode: 'untrusted' }, '/sandbox', {
      backend: 'linux-bwrap',
      processTree: 'contained',
      filesystem: 'root-jailed',
      resources: 'os-enforced',
      network: 'deny',
      privilege: 'dropped',
      envHygiene: 'scrubbed',
    });
    expect(p.requestedMode).toBe('untrusted');
    expect(p.mode).toBe('untrusted');
    expect(p.toolSurface).toBe('full');
    expect(p.securityDegraded).toEqual([]);
    expect(p.onClose).toBe('discard');
    expect(p.shellEscape).toBe('deny');
    expect(p.pathContainment).toBe('strict');
  });

  it('生效 mode 为 untrusted ⟺ requiresJail（runner 据此省掉等价派生）', () => {
    const l4 = {
      backend: 'linux-bwrap',
      processTree: 'contained',
      filesystem: 'root-jailed',
      resources: 'os-enforced',
      network: 'deny',
      privilege: 'dropped',
      envHygiene: 'scrubbed',
    } as const;
    const untrustedL4 = resolveEffectiveEffectPolicy({ mode: 'untrusted' }, '/sandbox', { ...l4 });
    expect(untrustedL4.mode).toBe('untrusted');
    expect(requiresJail(untrustedL4)).toBe(true);

    // degrade：requestedMode 仍是 untrusted，但 mode 已改名 → 不要求 jail
    const degraded = resolveEffectiveEffectPolicy(
      { mode: 'untrusted', untrustedAdmission: 'degrade' },
      '/sandbox',
      { ...l4, backend: 'supervised-spawn', processTree: 'killable', filesystem: 'cwd-pin', resources: 'best-effort', network: 'open', privilege: 'same' },
    );
    expect(degraded.requestedMode).toBe('untrusted');
    expect(degraded.mode).toBe('workspace');
    expect(requiresJail(degraded)).toBe(false);

    // mode 只可能是 requestedMode 或降级后的 workspace，不会凭空升高
    for (const mode of ['workspace', 'project', 'host'] as const) {
      const p = resolveEffectiveEffectPolicy({ mode }, '/ws');
      expect(requiresJail(p), mode).toBe(false);
      expect(p.mode === 'untrusted').toBe(false);
    }
  });

  it('untrusted degrade: renames effectiveMode, reduces surface, reports degraded', () => {
    const p = resolveEffectiveEffectPolicy(
      { mode: 'untrusted', untrustedAdmission: 'degrade', shellEscape: 'allow' },
      '/sandbox',
      {
        backend: 'supervised-spawn',
        processTree: 'killable',
        filesystem: 'cwd-pin',
        resources: 'best-effort',
        network: 'open',
        privilege: 'same',
        envHygiene: 'scrubbed',
      },
    );
    expect(p.requestedMode).toBe('untrusted');
    expect(p.mode).toBe('workspace');
    expect(p.toolSurface).toBe('reduced');
    expect(p.securityDegraded).toContain('no_process_jail');
    expect(p.securityDegraded).toContain('filesystem_not_jailed');
    // open egress must be declared even after mode rename
    expect(p.securityDegraded).toContain('network_open');
    // degraded must not leave shell allow as a hole
    expect(p.shellEscape).toBe('deny');
    // discard-on-close is kept as untrusted intent residue
    expect(p.onClose).toBe('discard');
    expect(p.pathContainment).toBe('strict');
  });

  it('untrusted pins pathContainment even if config tries to loosen it', () => {
    const p = resolveEffectiveEffectPolicy(
      { mode: 'untrusted', untrustedAdmission: 'degrade', pathContainment: 'none' },
      '/sandbox',
      {
        backend: 'supervised-spawn',
        processTree: 'killable',
        filesystem: 'cwd-pin',
        resources: 'best-effort',
        network: 'deny',
        privilege: 'same',
        envHygiene: 'scrubbed',
      },
    );
    expect(p.pathContainment).toBe('strict');
    expect(p.shellEscape).toBe('deny');
  });

  it('isToolAllowedOnSurface strips egress/exec on reduced', () => {
    expect(isToolAllowedOnSurface('file_write', 'full')).toBe(true);
    expect(isToolAllowedOnSurface('file_write', 'reduced')).toBe(true);
    expect(isToolAllowedOnSurface('shell', 'reduced')).toBe(false);
    expect(isToolAllowedOnSurface('http_request', 'reduced')).toBe(false);
    expect(isToolAllowedOnSurface('web_search', 'reduced')).toBe(false);
    expect(isToolAllowedOnSurface('send_file', 'reduced')).toBe(false);
    expect(isToolAllowedOnSurface('file_read', 'reduced')).toBe(true);
  });

  it('capability tags beat names (B1 alias bypass is closed)', () => {
    // Unknown name is rejected on reduced even if it is not on any denylist
    expect(isToolAllowedOnSurface('bash_command', 'reduced')).toBe(false);
    expect(isToolAllowedOnSurface('run_script', 'reduced')).toBe(false);
    // Explicit tags decide
    expect(isToolAllowedOnSurface('bash_command', 'reduced', ['exec'])).toBe(false);
    expect(isToolAllowedOnSurface('my_helper', 'reduced', ['fs-read'])).toBe(true);
    // explicit [] is authoritative: no dangerous caps → allowed on reduced
    expect(isToolAllowedOnSurface('my_helper', 'reduced', [])).toBe(true);
    // MCP-style names default to unknown → rejected
    expect(isToolAllowedOnSurface('srv__browser_navigate', 'reduced')).toBe(false);
  });

  it('overrides win over mode defaults', () => {
    const p = resolveEffectiveEffectPolicy(
      { mode: 'workspace', pathContainment: 'soft', shellEscape: 'allow', commit: 'manual' },
      '/ws',
    );
    expect(p.pathContainment).toBe('soft');
    expect(p.shellEscape).toBe('allow');
    expect(p.commit).toBe('manual');
  });

  it('transactionRoots join allowRoots', () => {
    const p = resolveEffectiveEffectPolicy(
      { mode: 'host', transactionRoots: ['/data/ext'] },
      '/home',
    );
    expect(p.allowRoots).toEqual(expect.arrayContaining(['/home', '/data/ext']));
  });
});

describe('L2 path containment', () => {
  const root = resolve('/octopi/ws');

  it('allows paths inside root', () => {
    expect(isPathUnderRoots(join(root, 'a.txt'), [root])).toBe(true);
    expect(isPathUnderRoots(root, [root])).toBe(true);
  });

  it('rejects escapes', () => {
    expect(isPathUnderRoots('/etc/passwd', [root])).toBe(false);
    expect(isPathUnderRoots(resolve(root, '..', 'other', 'x'), [root])).toBe(false);
    // prefix attack: /octopi/ws-evil must not match /octopi/ws
    expect(isPathUnderRoots(resolve(root + '-evil', 'x'), [root])).toBe(false);
  });

  it('resolveToolPath throws on strict escape', () => {
    expect(() =>
      resolveToolPath('/etc/passwd', root, {
        allowRoots: [root],
        containment: 'strict',
      }),
    ).toThrow(/path_forbidden/);
  });

  it('resolveToolPath allows relative under root', () => {
    const p = resolveToolPath('notes/a.txt', root, {
      allowRoots: [root],
      containment: 'strict',
    });
    expect(p).toBe(join(root, 'notes/a.txt'));
  });

  it('soft containment passes through', () => {
    const p = resolveToolPath('/etc/hosts', root, {
      allowRoots: [root],
      containment: 'soft',
    });
    expect(p).toBe(resolve('/etc/hosts'));
  });

  it('isPathAllowed mirrors resolve rules', () => {
    expect(isPathAllowed(join(root, 'f'), [root], 'strict')).toBe(true);
    expect(isPathAllowed('/etc/f', [root], 'strict')).toBe(false);
    expect(isPathAllowed('/etc/f', [root], 'none')).toBe(true);
  });
});

describe('requiresJail（runner 与 Web 观测面共享的 jail 谓词）', () => {
  const eff = (requestedMode: string, mode: string) =>
    ({ requestedMode, mode }) as Parameters<typeof requiresJail>[0];

  it('untrusted 请求且仍生效 → 进 jail', () => {
    expect(requiresJail(eff('untrusted', 'untrusted'))).toBe(true);
  });

  it('非 untrusted 请求 → 不进 jail', () => {
    expect(requiresJail(eff('workspace', 'workspace'))).toBe(false);
    expect(requiresJail(eff('host', 'host'))).toBe(false);
    expect(requiresJail(eff('project', 'project'))).toBe(false);
  });

  it('untrusted 被 admission 降级 → 不进 jail（与 runner 判据一致）', () => {
    expect(requiresJail(eff('untrusted', 'workspace'))).toBe(false);
    expect(requiresJail(eff('untrusted', 'host'))).toBe(false);
  });
});
