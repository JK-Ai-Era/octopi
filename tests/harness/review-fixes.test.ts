/**
 * 审查修复回归 — C3 fail-closed / M3 单调游标 / C1 restorer 非伪造
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { resolveToolPath } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/platform.js';
import { reverseAgentOverwrite } from '@octopi-agent/engine/harness/extension/execution-environment/undo-merge.js';
import {
  TurnFileUndoLog,
} from '@octopi-agent/engine/harness/extension/execution-environment/undo-log.js';
import {
  JournaledMemoryStore,
  createMemoryRestorer,
} from '@octopi-agent/engine/harness/extension/execution-environment/memory-undo.js';
import { InMemoryMemoryStore } from '@octopi-agent/engine/harness/memory/store.js';

describe('review fixes', () => {
  it('C3: strict + empty roots fail-closed', () => {
    expect(() =>
      resolveToolPath('/etc/passwd', '/ws', { containment: 'strict', allowRoots: [] }),
    ).toThrow(/path_forbidden/);
    expect(() =>
      resolveToolPath('a.txt', '/ws', { containment: 'strict' }),
    ).toThrow(/path_forbidden/);
    // soft + empty roots passes (audit)
    expect(resolveToolPath('/etc/hosts', '/ws', { containment: 'soft', allowRoots: [] })).toBeTruthy();
  });

  it('M3: out-of-order hunks reverse completely without duplication', () => {
    // two edits; current has both after-images; locate-all then apply by position
    const before = 'A\nB\nC\nD\nE\n';
    const after = 'A2\nB\nC\nD2\nE\n';
    const current = 'A2\nB\nC\nD2\nE\n'; // clean after state
    const r = reverseAgentOverwrite(before, after, current);
    expect(r.kind).toBe('restored');
    if (r.kind === 'restored') {
      expect(r.content).toBe(before);
      expect(r.skippedHunks).toBe(0);
    }
  });

  it('M3: user-overwritten first hunk keeps user line and reverses second', () => {
    const before = 'A\nB\nC\nD\nE\n';
    const after = 'A2\nB\nC\nD2\nE\n';
    const current = 'A\nB\nC\nD2\nE\n'; // user restored A
    const r = reverseAgentOverwrite(before, after, current);
    expect(r.kind).toBe('restored');
    if (r.kind === 'restored') {
      expect(r.content).toBe('A\nB\nC\nD\nE\n');
    }
  });

  it('C1: restorer uses inner store so discard after seal does not re-journal', async () => {
    const root = join(tmpdir(), `octopi-fix-${randomUUID()}`);
    const sessionsDir = join(root, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    try {
      const inner = new InMemoryMemoryStore();
      const undo = await TurnFileUndoLog.begin({ sessionsDir, sessionId: 's1' });
      const journaled = new JournaledMemoryStore(inner, () => undo.memoryEffects);
      const id = await journaled.store({
        type: 'fact',
        content: 'x',
        source: 't',
        confidence: 1,
        importance: 1,
      } as never);

      // restorer must be built from INNER (production wiring does this)
      const restorer = createMemoryRestorer(inner);
      await undo.discard(restorer);
      expect(await inner.get(id)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
