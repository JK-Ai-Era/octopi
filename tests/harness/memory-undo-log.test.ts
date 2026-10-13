/**
 * ToolEffectPolicy L3 P2 — 记忆面 turn undo
 *
 * 覆盖：insert 逆放=delete、softDelete 逆放=恢复 before、
 * JournaledMemoryStore 记账、steward（无 journal）不记账、gateway discard 逆放。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { InMemoryMemoryStore } from '@octopi-agent/engine/harness/memory/store.js';
import type { MemoryEntry, MemoryStore } from '@octopi-agent/engine/harness/memory/types.js';
import {
  TurnFileUndoLog,
  createUnconfiguredMemoryEffects,
} from '@octopi-agent/engine/harness/extension/execution-environment/undo-log.js';
import {
  JournaledMemoryStore,
  createMemoryRestorer,
  TurnMemoryJournal,
  discardMemoryUndo,
} from '@octopi-agent/engine/harness/extension/execution-environment/memory-undo.js';
import type { MemoryEffectJournal } from '@octopi-agent/core/types/tools.js';

function baseEntry(content: string): Omit<
  MemoryEntry,
  'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'decayFactor'
> {
  return {
    type: 'fact',
    content,
    source: 'test',
    confidence: 0.9,
    importance: 0.5,
  } as never;
}

describe('TurnMemoryJournal + JournaledMemoryStore', () => {
  let root: string;
  let sessionsDir: string;
  const sessionId = 'sess-mem';

  beforeEach(async () => {
    root = join(tmpdir(), `octopi-mem-${randomUUID()}`);
    sessionsDir = join(root, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('discards memory_store insert by deleting the row', async () => {
    const inner = new InMemoryMemoryStore();
    const undo = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    const store = new JournaledMemoryStore(inner, () => undo.memoryEffects);

    const id = await store.store(baseEntry('hello mem'));
    expect(await store.get(id)).not.toBeNull();

    const result = await undo.discard(createMemoryRestorer(inner));
    expect(await store.get(id)).toBeNull();
    expect(result.memory.reversed).toEqual([{ domain: 'memory', id, op: 'insert' }]);
    expect(result.memory.failed).toEqual([]);
    expect(result.memory.entries).toBe(1);
  });

  it('supersede undo: restore old row and drop new insert', async () => {
    const inner = new InMemoryMemoryStore();
    const undo = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    const store = new JournaledMemoryStore(inner, () => undo.memoryEffects);

    const oldId = await store.store(baseEntry('obsolete conclusion'));
    const newId = await store.store(baseEntry('replacement'));
    await store.softDelete(oldId, { by: 'memory_store.supersede', reason: 'supersede', winnerId: newId });
    expect((await store.get(oldId))?.deleted).toBe(true);
    expect(await store.get(newId)).not.toBeNull();

    const result = await undo.discard(createMemoryRestorer(inner));
    // 新插入被逆放删除；旧条目恢复未删
    expect(await store.get(newId)).toBeNull();
    expect((await store.get(oldId))?.deleted).toBeFalsy();
    expect(result.memory.entries).toBe(3);
  });

  it('same-id store then softDelete fully undoes to no row', async () => {
    const inner = new InMemoryMemoryStore();
    const undo = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    const store = new JournaledMemoryStore(inner, () => undo.memoryEffects);

    const id = await store.store(baseEntry('temp'));
    await store.softDelete(id, { by: 'test', reason: 'supersede' });

    await undo.discard(createMemoryRestorer(inner));
    // insert 逆放 = 删除整行
    expect(await store.get(id)).toBeNull();
  });

  it('commit keeps memory rows and clears journal', async () => {
    const inner = new InMemoryMemoryStore();
    const undo = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    const store = new JournaledMemoryStore(inner, () => undo.memoryEffects);
    const id = await store.store(baseEntry('keep me'));

    await undo.commit();
    expect(await store.get(id)).not.toBeNull();
  });

  it('without active journal writes are not recorded (steward path)', async () => {
    const inner = new InMemoryMemoryStore();
    const store = new JournaledMemoryStore(inner, () => undefined);
    const id = await store.store(baseEntry('steward write'));

    const result = await discardMemoryUndo(join(sessionsDir, sessionId, 'undo'));
    expect(result.entries).toBe(0);
    expect(await store.get(id)).not.toBeNull();
  });

  it('unconfigured memory effects fail closed', async () => {
    await expect(
      createUnconfiguredMemoryEffects().recordInsert('memory', 'x'),
    ).rejects.toThrow(/memory_effects_not_configured/);
  });

  it('TurnMemoryJournal seals after discard', async () => {
    const undoRoot = join(sessionsDir, sessionId, 'undo');
    await mkdir(undoRoot, { recursive: true });
    const j = new TurnMemoryJournal(undoRoot);
    await j.recordInsert('memory', 'a');
    j.seal();
    await expect(j.recordInsert('memory', 'b')).rejects.toThrow(/sealed/);
  });
});
