/**
 * ToolEffectPolicy L3 — Turn 文件 undo（P1）
 *
 * 覆盖：create/overwrite/append 记账、coalesce、discard 逆放、用户手改保留、
 * 二进制整文件用户优先、文本三方合并、commit 保留效应。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  TurnFileUndoLog,
  commitSessionFileUndo,
  discardSessionFileUndo,
  resolveSessionUndoPaths,
} from '@octopi-agent/engine/harness/extension/execution-environment/undo-log.js';
import { reverseAgentOverwrite, merge3Lines } from '@octopi-agent/engine/harness/extension/execution-environment/undo-merge.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('TurnFileUndoLog', () => {
  let root: string;
  let sessionsDir: string;
  let workDir: string;
  const sessionId = 'sess-undo';

  beforeEach(async () => {
    root = join(tmpdir(), `octopi-undo-${randomUUID()}`);
    sessionsDir = join(root, 'sessions');
    workDir = join(root, 'work');
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('discards create by deleting the new file', async () => {
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    const p = join(workDir, 'new.txt');
    await log.writeFile(p, 'hello');
    expect(await exists(p)).toBe(true);

    const result = await log.discard();
    expect(await exists(p)).toBe(false);
    expect(result.discarded).toEqual([{ path: p, action: 'deleted' }]);
    expect(result.entries).toBe(1);
    expect(await exists(resolveSessionUndoPaths(sessionsDir, sessionId).root)).toBe(false);
  });

  it('discards overwrite by restoring before bytes', async () => {
    const p = join(workDir, 'a.txt');
    await writeFile(p, 'before');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.writeFile(p, 'after');

    await log.discard();
    expect(await readFile(p, 'utf8')).toBe('before');
  });

  it('coalesces multiple writes: first before wins', async () => {
    const p = join(workDir, 'c.txt');
    await writeFile(p, 'v0');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.writeFile(p, 'v1');
    await log.writeFile(p, 'v2');
    await log.writeFile(p, 'v3');
    expect(log.size).toBe(1);

    await log.discard();
    expect(await readFile(p, 'utf8')).toBe('v0');
  });

  it('append undo restores full before content', async () => {
    const p = join(workDir, 'app.txt');
    await writeFile(p, 'base');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.appendFile(p, '+tail');

    expect(await readFile(p, 'utf8')).toBe('base+tail');
    await log.discard();
    expect(await readFile(p, 'utf8')).toBe('base');
  });

  it('keeps user edits when user overwrote after agent write (text 3WM)', async () => {
    const p = join(workDir, 'm.txt');
    await writeFile(p, 'line1\nline2\nline3\n');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.writeFile(p, 'line1\nAGENT\nline3\n');
    // 用户在 agent 写之后改了 line3
    await writeFile(p, 'line1\nAGENT\nUSER3\n');

    const result = await log.discard();
    const text = await readFile(p, 'utf8');
    expect(text).toContain('USER3');
    expect(text).not.toContain('AGENT');
    expect(text).toContain('line1');
    expect(result.discarded.some((d) => d.path === p)).toBe(true);
  });

  it('binary overwrite with user edit keeps current (binary_user_wins)', async () => {
    const p = join(workDir, 'bin.dat');
    const before = Buffer.from([1, 2, 3, 0, 4]);
    const after = Buffer.from([9, 9, 9, 0, 9]);
    const user = Buffer.from([7, 7, 7, 0, 7]);
    await writeFile(p, before);
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.writeFile(p, after);
    await writeFile(p, user);

    const result = await log.discard();
    expect(await readFile(p)).toEqual(user);
    expect(result.keptUserEdits).toEqual([{ path: p, reason: 'binary_user_wins' }]);
  });

  it('clean binary overwrite is fully restored', async () => {
    const p = join(workDir, 'b2.dat');
    const before = Buffer.from([1, 0, 2]);
    await writeFile(p, before);
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.writeFile(p, Buffer.from([3, 0, 4]));

    await log.discard();
    expect(await readFile(p)).toEqual(before);
  });

  it('user delete of agent file is not resurrected', async () => {
    const p = join(workDir, 'del.txt');
    await writeFile(p, 'orig');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.writeFile(p, 'agent');
    await rm(p);

    const result = await log.discard();
    expect(await exists(p)).toBe(false);
    expect(result.keptUserEdits).toEqual([{ path: p, reason: 'user_deleted' }]);
  });

  it('commit keeps effects and removes undo dir', async () => {
    const p = join(workDir, 'keep.txt');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.writeFile(p, 'kept');
    await log.commit();
    expect(await readFile(p, 'utf8')).toBe('kept');
    expect(await exists(resolveSessionUndoPaths(sessionsDir, sessionId).root)).toBe(false);
  });

  it('begin commits leftover undo (continue after abort = commit)', async () => {
    const p = join(workDir, 'left.txt');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.writeFile(p, 'from-aborted-turn');
    // 不 commit/discard，直接 begin 下一轮
    await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    expect(await readFile(p, 'utf8')).toBe('from-aborted-turn');
    // 新 log 为空
    const result = await discardSessionFileUndo(sessionsDir, sessionId);
    expect(result.entries).toBe(0);
  });

  it('create with user recreate keeps user file', async () => {
    const p = join(workDir, 're.txt');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.writeFile(p, 'agent-created');
    await writeFile(p, 'user-rewrote');

    const result = await log.discard();
    expect(await readFile(p, 'utf8')).toBe('user-rewrote');
    expect(result.keptUserEdits[0]?.reason).toBe('user_recreated');
  });
});

describe('undo-merge reverseAgentOverwrite', () => {
  it('restores before when current equals after', () => {
    expect(reverseAgentOverwrite('a\nb', 'a\nX', 'a\nX')).toEqual({
      kind: 'restored',
      content: 'a\nb',
      skippedHunks: 0,
    });
  });

  it('merges user-only delta and reverses agent line', () => {
    // before=before / after=agent / current=agent+user-touch
    const r = reverseAgentOverwrite('before\n', 'agent\n', 'agent\nuser-touch\n');
    expect(r.kind).toBe('restored');
    if (r.kind === 'restored') {
      expect(r.content).toBe('before\nuser-touch\n');
      expect(r.skippedHunks).toBe(0);
    }
  });

  it('skips hunk when user overwrote the agent line', () => {
    const r = reverseAgentOverwrite('before\n', 'agent\n', 'USER\n');
    expect(r.kind).toBe('restored');
    if (r.kind === 'restored') {
      expect(r.content).toBe('USER\n');
      expect(r.skippedHunks).toBe(1);
    }
  });

  it('merge3Lines takes theirs when ours unchanged', () => {
    expect(merge3Lines(['x'], ['x'], ['y'])).toEqual(['y']);
  });
});
