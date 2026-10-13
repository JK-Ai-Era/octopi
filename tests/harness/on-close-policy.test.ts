/**
 * onClose — commit=manual 下会话关闭策略
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  TurnFileUndoLog,
  resolveSessionUndoOnClose,
  resolveSessionUndoPaths,
} from '@octopi-agent/engine/harness/extension/execution-environment/undo-log.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('resolveSessionUndoOnClose', () => {
  let root: string;
  let sessionsDir: string;
  const sessionId = 's-close';

  beforeEach(async () => {
    root = join(tmpdir(), `octopi-close-${randomUUID()}`);
    sessionsDir = join(root, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('onClose=commit keeps effects and clears undo', async () => {
    const p = join(root, 'w.txt');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.writeFile(p, 'kept');

    const action = await resolveSessionUndoOnClose({ sessionsDir, sessionId, onClose: 'commit' });
    expect(action).toBe('committed');
    expect(await readFile(p, 'utf8')).toBe('kept');
    expect(await exists(resolveSessionUndoPaths(sessionsDir, sessionId).root)).toBe(false);
  });

  it('onClose=discard reverses effects', async () => {
    const p = join(root, 'w.txt');
    await writeFile(p, 'before');
    const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId });
    await log.writeFile(p, 'after');

    const action = await resolveSessionUndoOnClose({ sessionsDir, sessionId, onClose: 'discard' });
    expect(action).toBe('discarded');
    expect(await readFile(p, 'utf8')).toBe('before');
    expect(await exists(resolveSessionUndoPaths(sessionsDir, sessionId).root)).toBe(false);
  });

  it('none when no undo dir', async () => {
    const action = await resolveSessionUndoOnClose({ sessionsDir, sessionId: 'nope', onClose: 'commit' });
    expect(action).toBe('none');
  });
});
