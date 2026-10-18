/**
 * file_mkdir / file_rename / file_copy / file_stat / file_rmdir
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFileMkdirTool,
  createFileRenameTool,
  createFileCopyTool,
  createFileStatTool,
  createFileRmdirTool,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/file-ops.js';
import { TurnFileUndoLog } from '@octopi-agent/engine/harness/extension/execution-environment/undo-log.js';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('file ops (cross-platform)', () => {
  let root: string;
  let ws: string;
  let undo: TurnFileUndoLog;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'octopi-ops-'));
    ws = join(root, 'ws');
    await mkdir(ws, { recursive: true });
    undo = await TurnFileUndoLog.begin({
      sessionsDir: join(root, 'sessions'),
      sessionId: 'ops',
    });
  });

  afterEach(async () => {
    await undo.commit().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const ctx = () => ({
    sessionId: 'ops',
    agentId: 'a',
    messages: [],
    cwd: ws,
    pathRoots: [ws],
    pathContainment: 'strict' as const,
    effectChannel: 'engine' as const,
    fileEffects: undo,
    attachmentRoots: [] as string[],
  });

  it('file_mkdir creates nested dirs', async () => {
    const tool = createFileMkdirTool();
    const dir = join(ws, 'a', 'b');
    const r = await tool.handler({ path: dir }, ctx());
    expect(r).toMatchObject({ created: true });
    expect(await exists(dir)).toBe(true);
    // idempotent
    const r2 = await tool.handler({ path: dir }, ctx());
    expect(r2).toMatchObject({ existed: true });
  });

  it('file_rename moves a file and journals undo', async () => {
    const from = join(ws, 'old.txt');
    const to = join(ws, 'sub', 'new.txt');
    await writeFile(from, 'payload', 'utf8');
    await mkdir(join(ws, 'sub'), { recursive: true });
    const tool = createFileRenameTool();
    const r = await tool.handler({ from, to }, ctx());
    expect(r).toMatchObject({ renamed: true, kind: 'file', reversible: true });
    expect(await exists(from)).toBe(false);
    expect(await readFile(to, 'utf8')).toBe('payload');

    await undo.discard(undefined as never);
    expect(await exists(from)).toBe(true);
    expect(await readFile(from, 'utf8')).toBe('payload');
    expect(await exists(to)).toBe(false);
  });

  it('file_rename replaces existing destination file and undo restores dest', async () => {
    const from = join(ws, 'a.txt');
    const to = join(ws, 'b.txt');
    await writeFile(from, 'A', 'utf8');
    await writeFile(to, 'B-OLD', 'utf8');
    const tool = createFileRenameTool();
    await tool.handler({ from, to }, ctx());
    expect(await exists(from)).toBe(false);
    expect(await readFile(to, 'utf8')).toBe('A');

    // Root fix: dest `before` must be journaled before rm/rename
    await undo.discard(undefined as never);
    expect(await readFile(from, 'utf8')).toBe('A');
    expect(await readFile(to, 'utf8')).toBe('B-OLD');
  });

  it('file_rename rejects missing source', async () => {
    const tool = createFileRenameTool();
    await expect(
      tool.handler({ from: join(ws, 'nope'), to: join(ws, 'x') }, ctx()),
    ).rejects.toThrow(/not found/i);
  });

  it('file_copy copies without overwriting by default', async () => {
    const from = join(ws, 'src.bin');
    const to = join(ws, 'dst.bin');
    await writeFile(from, Buffer.from([1, 2, 3]));
    const tool = createFileCopyTool();
    await tool.handler({ from, to }, ctx());
    expect(await readFile(to)).toEqual(Buffer.from([1, 2, 3]));

    await expect(tool.handler({ from, to }, ctx())).rejects.toThrow(/exists/i);
    await tool.handler({ from, to, overwrite: true }, ctx());
  });

  it('file_stat reports type and missing', async () => {
    const f = join(ws, 'meta.txt');
    await writeFile(f, 'abc', 'utf8');
    const tool = createFileStatTool();
    const r = await tool.handler({ path: f }, ctx());
    expect(r).toMatchObject({ exists: true, kind: 'file', size: 3 });
    const missing = await tool.handler({ path: join(ws, 'zz') }, ctx());
    expect(missing).toMatchObject({ exists: false });
  });

  it('file_rmdir removes empty dir only', async () => {
    const dir = join(ws, 'empty');
    await mkdir(dir, { recursive: true });
    const tool = createFileRmdirTool();
    await tool.handler({ path: dir }, ctx());
    expect(await exists(dir)).toBe(false);

    const full = join(ws, 'full');
    await mkdir(full, { recursive: true });
    await writeFile(join(full, 'f.txt'), 'x', 'utf8');
    await expect(tool.handler({ path: full }, ctx())).rejects.toThrow(/not empty/i);
  });

  it('rejects paths outside allowRoots', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    for (const tool of [
      createFileMkdirTool(),
      createFileRmdirTool(),
      createFileStatTool(),
    ]) {
      await expect(tool.handler({ path: outside }, ctx())).rejects.toThrow(
        /path_forbidden|forbidden|outside/i,
      );
    }
  });

  it('file_mkdir is effect-gated: host-gate prompts for out-of-roots create, deny leaves no dir', async () => {
    const tool = createFileMkdirTool();
    const target = join(root, 'outside-mk');
    const seen: unknown[] = [];
    const confirm = async (intent: unknown): Promise<'deny'> => {
      seen.push(intent);
      return 'deny';
    };
    await expect(
      tool.handler(
        { path: target },
        { ...ctx(), pathContainment: 'none', effectChannel: 'host-gate', confirmEffect: confirm },
      ),
      // anchored: gate errors must surface unwrapped (a wrapped
      // `Failed to create directory …: effect_denied` would not match)
    ).rejects.toThrow(/^effect_denied/);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'file.write', mode: 'create', transactional: false });
    expect(await exists(target)).toBe(false);
  });

  it('file_mkdir in-roots create auto-allows without prompting (symmetric with rmdir)', async () => {
    const tool = createFileMkdirTool();
    let prompts = 0;
    const confirm = async (): Promise<'approve'> => {
      prompts += 1;
      return 'approve';
    };
    const host = { ...ctx(), effectChannel: 'host-gate' as const, confirmEffect: confirm };
    const r = await tool.handler({ path: join(ws, 'auto-dir') }, host);
    expect(r).toMatchObject({ created: true, reversible: false });
    expect(prompts).toBe(0);
    expect(await exists(join(ws, 'auto-dir'))).toBe(true);
    // symmetry anchor: file_rmdir in-roots is equally prompt-free under host-gate
    await createFileRmdirTool().handler({ path: join(ws, 'auto-dir') }, host);
    expect(prompts).toBe(0);
  });

  it('file_mkdir host-gate approve creates the dir; idempotent re-call does not prompt again', async () => {
    const tool = createFileMkdirTool();
    const target = join(root, 'approved-out');
    let prompts = 0;
    const confirm = async (): Promise<'approve'> => {
      prompts += 1;
      return 'approve';
    };
    const host = {
      ...ctx(),
      pathContainment: 'none' as const,
      effectChannel: 'host-gate' as const,
      confirmEffect: confirm,
    };
    const r = await tool.handler({ path: target }, host);
    expect(r).toMatchObject({ created: true });
    expect(await exists(target)).toBe(true);
    expect(prompts).toBe(1);
    // second call is a no-op early return: it must not prompt again
    const r2 = await tool.handler({ path: target }, host);
    expect(r2).toMatchObject({ existed: true });
    expect(prompts).toBe(1);
  });
});
