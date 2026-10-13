/**
 * ToolEffectPolicy P3 — 运行模式展开 + L2 路径包含
 */
import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';

import {
  resolveEffectiveEffectPolicy,
  isPathAllowed,
} from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';
import {
  resolveToolPath,
  isPathUnderRoots,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/platform.js';

describe('resolveEffectiveEffectPolicy', () => {
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

  it('untrusted: onClose discard + strict + shell deny', () => {
    const p = resolveEffectiveEffectPolicy({ mode: 'untrusted' }, '/sandbox');
    expect(p.pathContainment).toBe('strict');
    expect(p.onClose).toBe('discard');
    expect(p.shellEscape).toBe('deny');
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
