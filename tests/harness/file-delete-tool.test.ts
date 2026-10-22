/**
 * file_delete — L2 + undo + self-protection
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createFileDeleteTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/builtin.js';
import { TurnFileUndoLog } from '@octopi-agent/engine/harness/extension/execution-environment/undo-log.js';
import { testMemoryEffects } from '../helpers/tool-context.js';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('file_delete', () => {
  let root: string;
  let sessionsDir: string;
  let undo: TurnFileUndoLog;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'octopi-del-'));
    sessionsDir = join(root, 'sessions');
    await mkdir(join(root, 'ws'), { recursive: true });
    undo = await TurnFileUndoLog.begin({
      sessionsDir,
      sessionId: 's1',
    });
  });

  afterEach(async () => {
    await undo.commit().catch(() => {});
  });

  const makeCtx = (workspace: string) => ({
    sessionId: 's1',
    agentId: 'a',
    messages: [],
    cwd: workspace,
    pathRoots: [workspace],
    pathContainment: 'strict' as const,
    effectChannel: 'engine' as const,
    fileEffects: undo,
    memoryEffects: testMemoryEffects(),
  });

  it('deletes a file under root and journals before for undo', async () => {
    const ws = join(root, 'ws');
    const f = join(ws, 'a.txt');
    await writeFile(f, 'hello', 'utf8');
    const tool = createFileDeleteTool();
    const result = await tool.handler({ path: f }, makeCtx(ws));
    expect(result).toMatchObject({ deleted: true, path: f });
    expect(await exists(f)).toBe(false);

    // reverse via discard restores content
    const res = await undo.discard(undefined as never).catch(() => null);
    void res;
    // turn undo discard needs a restorer for memory only; file restore is built-in
  });

  it('rejects path outside allowRoots', async () => {
    const ws = join(root, 'ws');
    const outside = join(root, 'secret.txt');
    await writeFile(outside, 'x', 'utf8');
    const tool = createFileDeleteTool();
    await expect(tool.handler({ path: outside }, makeCtx(ws))).rejects.toThrow(
      /path_forbidden|forbidden|outside/i,
    );
    expect(await exists(outside)).toBe(true);
  });

  it('rejects directory targets', async () => {
    const ws = join(root, 'ws');
    const dir = join(ws, 'sub');
    await mkdir(dir, { recursive: true });
    const tool = createFileDeleteTool();
    await expect(tool.handler({ path: dir }, makeCtx(ws))).rejects.toThrow(/directory/i);
  });

  it('rejects session undo ledger', async () => {
    const ws = join(root, 'ws');
    const ledger = join(sessionsDir, 's1', 'undo', 'log.jsonl');
    await mkdir(join(sessionsDir, 's1', 'undo'), { recursive: true });
    await writeFile(ledger, '[]', 'utf8');
    const tool = createFileDeleteTool();
    await expect(tool.handler({ path: ledger }, makeCtx(ws))).rejects.toThrow(/undo/i);
  });

  it('missing file throws File not found', async () => {
    const ws = join(root, 'ws');
    const tool = createFileDeleteTool();
    await expect(tool.handler({ path: join(ws, 'nope.txt') }, makeCtx(ws))).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('file_delete undo restore', () => {
  it('discard restores deleted file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'octopi-del2-'));
    const sessionsDir = join(root, 'sessions');
    const ws = join(root, 'ws');
    await mkdir(ws, { recursive: true });
    const undo = await TurnFileUndoLog.begin({ sessionsDir, sessionId: 's2' });
    const f = join(ws, 'keep.txt');
    await writeFile(f, 'keep-me', 'utf8');
    const tool = createFileDeleteTool();
    await tool.handler(
      {
        path: f,
      },
      {
        sessionId: 's2',
        agentId: 'a',
        messages: [],
        cwd: ws,
        pathRoots: [ws],
        pathContainment: 'strict',
        effectChannel: 'engine',
        fileEffects: undo,
        memoryEffects: testMemoryEffects(),
      },
    );
    expect(await exists(f)).toBe(false);
    await undo.discard(undefined as never);
    expect(await exists(f)).toBe(true);
    expect(await readFile(f, 'utf8')).toBe('keep-me');
  });
});
