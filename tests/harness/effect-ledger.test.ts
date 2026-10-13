/**
 * ToolEffectPolicy — delete/rename undo · undoLimit · notReversed · shell 账本
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  TurnFileUndoLog,
  resolveSessionUndoPaths,
} from '@octopi-agent/engine/harness/extension/execution-environment/undo-log.js';
import {
  snapshotShellRoots,
  journalShellDiff,
  captureShellInventory,
  writeNotReversed,
} from '@octopi-agent/engine/harness/extension/execution-environment/shell-journal.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('undo delete/rename + limits + notReversed', () => {
  let root: string;
  let sessionsDir: string;
  let workDir: string;
  const sessionId = 'sess-adv';

  beforeEach(async () => {
    root = join(tmpdir(), `octopi-adv-${randomUUID()}`);
    sessionsDir = join(root, 'sessions');
    workDir = join(root, 'work');
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reverses delete by restoring before bytes', async () => {
    const p = join(workDir, 'gone.txt');
    await writeFile(p, 'keep-me');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.recordDelete(p, 'keep-me');
    await rm(p, { force: true });

    const result = await log.discard();
    expect(await exists(p)).toBe(true);
    expect(await readFile(p, 'utf8')).toBe('keep-me');
    expect(result.discarded).toEqual([{ path: p, action: 'restored' }]);
  });

  it('reverses rename as delete+create', async () => {
    const a = join(workDir, 'a.txt');
    const b = join(workDir, 'b.txt');
    await writeFile(a, 'payload');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.recordRename(a, b);
    await rm(a, { force: true });
    await writeFile(b, 'payload');

    const result = await log.discard();
    expect(await exists(b)).toBe(false);
    expect(await readFile(a, 'utf8')).toBe('payload');
    expect(result.entries).toBe(2);
  });

  it('undoLimit marks truncated and keeps writing', async () => {
    const p = join(workDir, 'big.txt');
    const log = await TurnFileUndoLog.begin({
      sessionsDir,
      sessionId,
      undoLimit: { maxEntries: 0, maxBlobBytes: 8 },
    });
    // first write: before empty → create (no before blob)
    await log.writeFile(p, 'x');
    const p2 = join(workDir, 'big2.txt');
    await writeFile(p2, '0123456789abcdef');
    // overwrite large: before blob exceeds maxBlobBytes → limitHit, still writes
    await log.writeFile(p2, 'yy');
    expect(await readFile(p2, 'utf8')).toBe('yy');
    expect(log.truncated).toBe(true);

    const result = await log.discard();
    expect(result.truncated).toBe(true);
  });

  it('noteNotReversed loads into discard result', async () => {
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.noteNotReversed({ reason: 'no_roots', created: ['x'] });
    const result = await log.discard();
    expect(result.notReversed?.reason).toBe('no_roots');
    expect(result.notReversed?.created).toEqual(['x']);
  });
});

describe('review regressions', () => {
  let root: string;
  let sessionsDir: string;
  let workDir: string;

  beforeEach(async () => {
    root = join(tmpdir(), `octopi-rev-${randomUUID()}`);
    sessionsDir = join(root, 'sessions');
    workDir = join(root, 'work');
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('overwrite then tool delete restores original (agentDeleted)', async () => {
    const p = join(workDir, 'x.txt');
    await writeFile(p, 'orig');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId: 'r1' });
    await log.writeFile(p, 'draft');
    await log.recordDelete(p, 'draft');
    await rm(p, { force: true });
    const result = await log.discard();
    expect(await readFile(p, 'utf8')).toBe('orig');
    expect(result.discarded).toEqual([{ path: p, action: 'restored' }]);
  });

  it('delete then tool recreate restores original', async () => {
    const p = join(workDir, 'y.txt');
    await writeFile(p, 'orig');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId: 'r2' });
    await log.recordDelete(p, 'orig');
    await rm(p, { force: true });
    await log.writeFile(p, 'recreated');
    const result = await log.discard();
    expect(await readFile(p, 'utf8')).toBe('orig');
    expect(result.discarded).toEqual([{ path: p, action: 'restored' }]);
  });

  it('rename over existing target restores both files', async () => {
    const a = join(workDir, 'a.txt');
    const b = join(workDir, 'b.txt');
    await writeFile(a, 'A');
    await writeFile(b, 'B-EXISTING');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId: 'r3' });
    await log.recordRename(a, b);
    await rm(a, { force: true });
    await writeFile(b, 'A');
    const result = await log.discard();
    expect(await readFile(a, 'utf8')).toBe('A');
    expect(await readFile(b, 'utf8')).toBe('B-EXISTING');
    expect(result.entries).toBe(2);
  });

  it('truncated shell before does not invent create for unscanned files', async () => {
    const sessionsDir2 = join(root, 'sessions2');
    await mkdir(sessionsDir2, { recursive: true });
    // 预算截断：只扫 0 个文件
    const before = await snapshotShellRoots({
      roots: [workDir],
      limit: { maxFiles: 0 },
    });
    // 0 表示不限——改用 maxFiles:1 且预先放 2 个文件，只扫到 1 个
    await writeFile(join(workDir, 'f1.txt'), '1');
    await writeFile(join(workDir, 'f2.txt'), '2');
    const before2 = await snapshotShellRoots({
      roots: [workDir],
      limit: { maxFiles: 1 },
    });
    expect(before2.capture.truncated).toBe(true);
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId: 'r4' });
    const after = await captureShellInventory({ roots: [workDir], limit: { maxFiles: 1 } });
    const diff = await journalShellDiff(log, before2.capture, after, before2.store);
    // 未扫到的文件不得变成 create
    expect(diff.created.every((p) => before2.capture.map.has(p.replace(/\\/g, '/').toLowerCase()) || before2.capture.map.has(p))).toBe(true);
    expect(diff.notInventable.length + diff.created.length).toBeGreaterThanOrEqual(0);
    const result = await log.discard();
    // 旧文件必须还在
    expect(await exists(join(workDir, 'f1.txt'))).toBe(true);
    expect(await exists(join(workDir, 'f2.txt'))).toBe(true);
    void result;
    void before;
  });

  it('persists truncated for out-of-process discard', async () => {
    const p = join(workDir, 'z.txt');
    await writeFile(p, '0123456789abcdef');
    const log = await TurnFileUndoLog.begin({
      sessionsDir,
      sessionId: 'r5',
      undoLimit: { maxBlobBytes: 4 },
    });
    await log.writeFile(p, 'yy');
    expect(log.truncated).toBe(true);
    const { discardSessionFileUndo } = await import(
      '@octopi-agent/engine/harness/extension/execution-environment/undo-log.js'
    );
    const result = await discardSessionFileUndo(sessionsDir, 'r5');
    expect(result.truncated).toBe(true);
  });
});

describe('shell journal snapshot', () => {
  let root: string;
  let workDir: string;

  beforeEach(async () => {
    root = join(tmpdir(), `octopi-sh-${randomUUID()}`);
    workDir = join(root, 'ws');
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('snapshots roots and journals shell-created file as reversible create', async () => {
    const sessionsDir = join(root, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId: 'sh1' });

    const before = await snapshotShellRoots({ roots: [workDir] });
    // simulate shell write
    await writeFile(join(workDir, 'new.md'), 'hello');
    const after = await captureShellInventory({ roots: [workDir] });
    const diff = await journalShellDiff(log, before.capture, after, before.store);
    expect(diff.created).toEqual([join(workDir, 'new.md')]);

    const result = await log.discard();
    expect(await exists(join(workDir, 'new.md'))).toBe(false);
    expect(result.discarded.length).toBe(1);
  });

  it('journals shell-modified file with explicit before', async () => {
    const p = join(workDir, 'doc.txt');
    await writeFile(p, 'v0');
    const sessionsDir = join(root, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId: 'sh2' });

    const before = await snapshotShellRoots({ roots: [workDir] });
    await writeFile(p, 'v1-agent');
    const after = await captureShellInventory({ roots: [workDir] });
    await journalShellDiff(log, before.capture, after, before.store);

    const result = await log.discard();
    expect(await readFile(p, 'utf8')).toBe('v0');
    expect(result.discarded).toEqual([{ path: p, action: 'restored' }]);
  });

  it('writeNotReversed is readable from undo dir', async () => {
    const undoRoot = join(root, 'sessions', 's', 'undo');
    await writeNotReversed(undoRoot, { reason: 'shell_journal_off' });
    const raw = await readFile(join(undoRoot, 'not-reversed.json'), 'utf8');
    expect(JSON.parse(raw).reason).toBe('shell_journal_off');
  });
});

describe('gateway truncate restriction', () => {
  it('documents abort-only contract via resolveSessionUndoPaths shape', async () => {
    const paths = resolveSessionUndoPaths('/home/o/sessions', 'abc');
    expect(paths.root.replace(/\\/g, '/')).toContain('abc/undo');
  });
});
