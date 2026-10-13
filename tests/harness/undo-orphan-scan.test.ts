/**
 * doctor 孤儿 undo 扫描 + Observer tool.effect.undo 字段
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  TurnFileUndoLog,
  scanOrphanSessionUndo,
  resolveSessionUndoPaths,
} from '@octopi-agent/engine/harness/extension/execution-environment/undo-log.js';

describe('scanOrphanSessionUndo', () => {
  let root: string;
  let sessionsDir: string;

  beforeEach(async () => {
    root = join(tmpdir(), `octopi-orphan-${randomUUID()}`);
    sessionsDir = join(root, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns empty when no undo dirs', async () => {
    await mkdir(join(sessionsDir, 's1'), { recursive: true });
    expect(await scanOrphanSessionUndo(sessionsDir)).toEqual([]);
  });

  it('reports leftover undo after crash (no commit/discard)', async () => {
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId: 's-crash' });
    const p = join(root, 'file.txt');
    await log.writeFile(p, 'data');
    // 模拟崩溃：不 commit/discard，只 seal 进程结束（目录仍在）
    const orphans = await scanOrphanSessionUndo(sessionsDir);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].entries).toBeGreaterThan(0);
  });

  it('commit removes undo dir from orphan list', async () => {
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId: 's-ok' });
    await log.writeFile(join(root, 'a.txt'), 'x');
    await log.commit();
    expect(await scanOrphanSessionUndo(sessionsDir)).toEqual([]);
    const { root: undoRoot } = resolveSessionUndoPaths(sessionsDir, 's-ok');
    expect(undoRoot).toContain('undo');
    // log.jsonl 已随 commit 删除
    await expect(readFile(join(undoRoot, 'log.jsonl'), 'utf8')).rejects.toThrow();
  });
});
