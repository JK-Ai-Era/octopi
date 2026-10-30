/**
 * `refuseFinalSymlink` — final-component link refusal (P2).
 *
 * Writing these tests exposed that the first version was **false green**: it used
 * `pathContainment: 'strict'`, where P1 already rejects an escaping link before
 * the guard runs, and an effects stub that silently dropped the third argument.
 * The guard could be deleted entirely and the suite still passed.
 *
 * So the cases below deliberately use what is needed to *reach* the guard:
 * - `pathContainment: 'soft'` — containment returns the lexical path, the link
 *   survives to the fs call, and only the guard can stop it;
 * - the real `TurnFileUndoLog` for write paths, so the shipped implementation is
 *   exercised rather than a stub.
 *
 * Scope, asserted as such: only the final component. Intermediate segments and
 * hard links are out of scope (see arch/path-containment-hardening.md §3.4).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isFinalSymlink,
  readFileNoFollow,
} from '@octopi-agent/engine/harness/shared/paths/index.js';
import {
  createFileReadTool,
  createFileWriteTool,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/builtin.js';
import { createFileCopyTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/file-ops.js';
import { TurnFileUndoLog } from '@octopi-agent/engine/harness/extension/execution-environment/undo-log.js';
import { resolveEffectiveEffectPolicy } from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'octopi-nofollow-'));
  cleanup.push(base);
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  const sessionsDir = join(base, 'sessions');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(root, 'plain.txt'), 'PLAIN\n');
  await writeFile(join(outside, 'secret.txt'), 'SECRET\n');
  // Planted between the containment check and the write.
  await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
  await symlink(join(outside, 'ghost.txt'), join(root, 'dangling.txt'));
  return { base, root, outside, sessionsDir };
}

/**
 * Context that reaches the guard: `soft` keeps the link in play, and the real
 * undo log means the shipped write implementation is under test.
 */
async function softCtx(root: string, sessionsDir: string, refuseFinalSymlink: boolean) {
  const undo = await TurnFileUndoLog.begin({ sessionsDir, sessionId: 'guard-test' });
  return {
    cwd: root,
    pathRoots: [root],
    pathContainment: 'soft' as const,
    refuseFinalSymlink,
    fileEffects: undo,
  };
}

describe('isFinalSymlink', () => {
  it('detects a link, including a dangling one, without following it', async () => {
    const { root } = await fixture();
    expect(isFinalSymlink(join(root, 'link.txt'))).toBe(true);
    expect(isFinalSymlink(join(root, 'dangling.txt'))).toBe(true);
  });

  it('is false for regular files and absent paths', async () => {
    const { root } = await fixture();
    expect(isFinalSymlink(join(root, 'plain.txt'))).toBe(false);
    expect(isFinalSymlink(join(root, 'absent.txt'))).toBe(false);
  });
});

describe('readFileNoFollow', () => {
  it('reads a regular file', async () => {
    const { root } = await fixture();
    expect(await readFileNoFollow(join(root, 'plain.txt'), 'utf8')).toBe('PLAIN\n');
  });

  it('refuses to follow a symlink', async () => {
    const { root } = await fixture();
    await expect(readFileNoFollow(join(root, 'link.txt'), 'utf8')).rejects.toThrow();
  });
});

describe('file_read guard (soft containment, so only the guard can stop it)', () => {
  it('refuses a link when the guard is on', async () => {
    const { root, sessionsDir } = await fixture();
    const tool = createFileReadTool();
    await expect(
      tool.handler({ path: 'link.txt', summarize: 'off' }, (await softCtx(root, sessionsDir, true)) as never),
    ).rejects.toThrow();
  });

  it('reads the link target when the guard is off (pre-P2 semantics)', async () => {
    const { root, sessionsDir } = await fixture();
    const tool = createFileReadTool();
    const result = await tool.handler(
      { path: 'link.txt', summarize: 'off' },
      (await softCtx(root, sessionsDir, false)) as never,
    );
    expect(JSON.stringify(result)).toContain('SECRET');
  });

  it('reads a plain file when the guard is on', async () => {
    const { root, sessionsDir } = await fixture();
    const tool = createFileReadTool();
    const result = await tool.handler(
      { path: 'plain.txt', summarize: 'off' },
      (await softCtx(root, sessionsDir, true)) as never,
    );
    expect(JSON.stringify(result)).toContain('PLAIN');
  });
});

describe('file_write guard (real TurnFileUndoLog)', () => {
  it('refuses to write through a link and leaves the target untouched', async () => {
    const { root, outside, sessionsDir } = await fixture();
    const tool = createFileWriteTool();
    await expect(
      tool.handler({ path: 'link.txt', content: 'PWNED\n' }, (await softCtx(root, sessionsDir, true)) as never),
    ).rejects.toThrow(/refuseFinalSymlink|path_forbidden/);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('SECRET\n');
  });

  it('refuses to append through a link', async () => {
    const { root, outside, sessionsDir } = await fixture();
    const tool = createFileWriteTool();
    await expect(
      tool.handler(
        { path: 'link.txt', content: 'PWNED\n', append: true },
        (await softCtx(root, sessionsDir, true)) as never,
      ),
    ).rejects.toThrow(/refuseFinalSymlink|path_forbidden/);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('SECRET\n');
  });

  it('follows the link when the guard is off (pre-P2 semantics preserved)', async () => {
    const { root, outside, sessionsDir } = await fixture();
    const tool = createFileWriteTool();
    await tool.handler({ path: 'link.txt', content: 'FOLLOWED\n' }, (await softCtx(root, sessionsDir, false)) as never);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('FOLLOWED\n');
  });

  it('writes a normal file when the guard is on', async () => {
    const { root, sessionsDir } = await fixture();
    const tool = createFileWriteTool();
    await tool.handler({ path: 'new.txt', content: 'OK' }, (await softCtx(root, sessionsDir, true)) as never);
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('OK');
  });
});

describe('file_copy guard (bypasses effects.writeFile)', () => {
  it('refuses to copy onto a link instead of following it', async () => {
    const { root, outside, sessionsDir } = await fixture();
    await writeFile(join(root, 'payload.bin'), 'PAYLOAD\n');
    const tool = createFileCopyTool();
    await expect(
      tool.handler(
        // `overwrite: true` is what reaches `copyFile`; without it the existing
        // destination check refuses first and the guard is never exercised.
        { from: 'payload.bin', to: 'link.txt', overwrite: true },
        (await softCtx(root, sessionsDir, true)) as never,
      ),
    ).rejects.toThrow(/refuseFinalSymlink|path_forbidden/);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('SECRET\n');
  });
});

describe('policy defaults', () => {
  const resolve = (mode: string, extra: Record<string, unknown> = {}) =>
    resolveEffectiveEffectPolicy(
      // This host has no L4 jail; `degrade` is the documented way to inspect an
      // untrusted policy's resolved values.
      { mode, untrustedAdmission: 'degrade', ...extra } as never,
      undefined,
      // No isolation profile: this host has no L4 jail, which is exactly the
      // degraded path `untrustedAdmission: 'degrade'` is meant to resolve.
      undefined,
    );

  it('is off for workspace/project/host and forced on for untrusted', () => {
    expect(resolve('workspace').refuseFinalSymlink).toBe(false);
    expect(resolve('project').refuseFinalSymlink).toBe(false);
    expect(resolve('host').refuseFinalSymlink).toBe(false);
    expect(resolve('untrusted').refuseFinalSymlink).toBe(true);
  });

  it('honours an explicit opt-in outside untrusted', () => {
    expect(resolve('workspace', { refuseFinalSymlink: true }).refuseFinalSymlink).toBe(true);
  });

  it('cannot be turned off in untrusted mode', () => {
    expect(resolve('untrusted', { refuseFinalSymlink: false }).refuseFinalSymlink).toBe(true);
  });
});
