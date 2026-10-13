/**
 * ToolEffectPolicy P4 — host-gate confirmEffect
 */
import { describe, it, expect, vi } from 'vitest';

import { gateEffect } from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';
import type { ConfirmEffect } from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';

describe('gateEffect host-gate', () => {
  it('auto-allows transactional file.write and memory.write', async () => {
    const confirm = vi.fn(async () => 'allow' as const);
    await gateEffect(
      { kind: 'file.write', path: '/ws/a', mode: 'create', transactional: true },
      { effects: 'host-gate', confirmEffect: confirm },
    );
    await gateEffect(
      { kind: 'memory.write', domain: 'memory', transactional: true },
      { effects: 'host-gate', confirmEffect: confirm },
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it('host-gate asks confirmEffect for non-transactional file.write', async () => {
    const seen: unknown[] = [];
    const confirm: ConfirmEffect = async (intent) => {
      seen.push(intent);
      return 'allow';
    };
    await gateEffect(
      { kind: 'file.write', path: '/etc/x', mode: 'overwrite', transactional: false },
      { effects: 'host-gate', confirmEffect: confirm },
    );
    expect(seen).toHaveLength(1);
    expect((seen[0] as { path: string }).path).toBe('/etc/x');
  });

  it('deny from host throws effect_denied', async () => {
    const confirm: ConfirmEffect = async () => 'deny';
    await expect(
      gateEffect(
        { kind: 'shell', command: 'rm -rf /' },
        { effects: 'host-gate', confirmEffect: confirm },
      ),
    ).rejects.toThrow(/effect_denied/);
  });

  it('host-gate without callback fail-closed', async () => {
    await expect(
      gateEffect(
        { kind: 'shell', command: 'ls' },
        { effects: 'host-gate' },
      ),
    ).rejects.toThrow(/confirm_effect_missing/);
  });

  it('engine channel does not invoke confirmEffect', async () => {
    const confirm = vi.fn(async () => 'allow' as const);
    await gateEffect(
      { kind: 'shell', command: 'ls' },
      { effects: 'engine', confirmEffect: confirm },
    );
    await gateEffect(
      { kind: 'file.write', path: '/tmp/x', mode: 'create', transactional: false },
      { effects: 'engine', confirmEffect: confirm },
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it('shell is non-transactional under host-gate', async () => {
    const confirm: ConfirmEffect = async (intent) => {
      expect(intent.kind).toBe('shell');
      return 'allow';
    };
    await gateEffect(
      { kind: 'shell', command: 'echo hi', cwd: '/ws' },
      { effects: 'host-gate', confirmEffect: confirm, shellEscape: 'confirm' },
    );
  });

  it('shellEscape=deny refuses shell even on engine channel (fail-closed)', async () => {
    await expect(
      gateEffect(
        { kind: 'shell', command: 'ls' },
        { effects: 'engine', shellEscape: 'deny' },
      ),
    ).rejects.toThrow(/shell_denied/);
  });

  it('shellEscape=confirm requires host-gate on engine channel', async () => {
    await expect(
      gateEffect(
        { kind: 'shell', command: 'ls' },
        { effects: 'engine', shellEscape: 'confirm' },
      ),
    ).rejects.toThrow(/shell_confirm_required/);
  });

  it('shellEscape=allow runs on engine channel', async () => {
    await gateEffect(
      { kind: 'shell', command: 'ls' },
      { effects: 'engine', shellEscape: 'allow' },
    );
  });
});
