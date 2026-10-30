/**
 * Path containment must hold against symbolic links.
 *
 * `isPathUnderRoots` is lexical (`resolve()`), so a link inside an allowed root
 * that points outside it used to pass the check while the following fs call
 * followed the link. These cases pin the realpath semantics for both read and
 * write paths.
 *
 * Hard links are NOT covered: realpath cannot distinguish them (same inode,
 * different name). That gap is documented, not silently accepted here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveToolPath,
  resolveReadableToolPath,
  isPathUnderRoots,
  isUnderAttachmentRoot,
  isUnderSessionUndoRoot,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/platform.js';
import {
  createFileReadTool,
  createFileWriteTool,
  createFileDeleteTool,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/builtin.js';
import { createFileEditTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/file-edit.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * Build a fixture: `root` (allowed) + `outside` (forbidden), plus links.
 * The root string is used verbatim (not pre-realpath'd) so that a fix which
 * only resolves one side of the comparison fails case "root alias" below.
 */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'octopi-contain-'));
  cleanup.push(base);
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(join(root, 'inside.txt'), 'INSIDE\n');
  await writeFile(join(root, 'sub', 'nested.txt'), 'NESTED\n');
  await writeFile(join(outside, 'secret.txt'), 'SECRET-OUTSIDE\n');
  await writeFile(join(root, '.env'), 'TOKEN=should-not-leak\n');

  // A link file inside the root pointing outside it.
  await symlink(join(outside, 'secret.txt'), join(root, 'link-out.txt'));
  // A link directory inside the root pointing outside it.
  await symlink(outside, join(root, 'dir-out'));
  // A link file inside the root pointing at another file inside the root.
  await symlink(join(root, 'inside.txt'), join(root, 'link-in.txt'));

  return { base, root, outside };
}

/** Minimal ToolFileEffects stub so write/delete tools can run their real body. */
function fileEffects() {
  const noop = async () => {};
  return {
    writeFile: (path: string, data: string | Uint8Array) => writeFile(path, data),
    appendFile: (path: string, data: string | Uint8Array) => writeFile(path, data, { flag: 'a' }),
    recordDelete: noop,
    recordCreate: noop,
    recordRename: noop,
    recordOverwrite: noop,
    noteNotReversed: noop,
  };
}

function ctx(root: string, extra: Record<string, unknown> = {}) {
  return { cwd: root, pathRoots: [root], pathContainment: 'strict', fileEffects: fileEffects(), ...extra };
}

describe('path containment: symlink escape (read)', () => {
  it('refuses a link inside the root that points outside it', async () => {
    const { root, outside } = await fixture();
    const tool = createFileReadTool();
    await expect(tool.handler({ path: 'link-out.txt', summarize: 'off' }, ctx(root) as never))
      .rejects.toThrow(/path_forbidden|escapes/);
    // The outside payload must never be returned.
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('SECRET-OUTSIDE\n');
  });

  it('refuses a path through a link directory that points outside it', async () => {
    const { root } = await fixture();
    const tool = createFileReadTool();
    await expect(tool.handler({ path: 'dir-out/secret.txt', summarize: 'off' }, ctx(root) as never))
      .rejects.toThrow(/path_forbidden|escapes/);
  });

  it('still allows a link that stays inside the root', async () => {
    const { root } = await fixture();
    const tool = createFileReadTool();
    const result = await tool.handler({ path: 'link-in.txt', summarize: 'off' }, ctx(root) as never);
    expect(JSON.stringify(result)).toContain('INSIDE');
  });

  it('accepts a root alias that differs from its realpath (macOS /var -> /private/var)', async () => {
    const { root } = await fixture();
    // mkdtemp returns the /var/... spelling on macOS; realpath yields /private/var/...
    // Resolving only the target and not the root would wrongly deny this.
    const tool = createFileReadTool();
    const result = await tool.handler({ path: 'inside.txt', summarize: 'off' }, ctx(root) as never);
    expect(JSON.stringify(result)).toContain('INSIDE');
  });
});

describe('path containment: symlink escape (write)', () => {
  it('refuses to overwrite through a link that points outside the root', async () => {
    const { root, outside } = await fixture();
    const tool = createFileWriteTool();
    await expect(tool.handler({ path: 'link-out.txt', content: 'PWNED\n' }, ctx(root) as never))
      .rejects.toThrow(/path_forbidden|escapes/);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('SECRET-OUTSIDE\n');
  });

  it('refuses to edit through a link that points outside the root', async () => {
    const { root, outside } = await fixture();
    const tool = createFileEditTool();
    await expect(
      tool.handler({ path: 'link-out.txt', old_text: 'SECRET-OUTSIDE', new_text: 'PWNED' }, ctx(root) as never),
    ).rejects.toThrow(/path_forbidden|escapes/);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('SECRET-OUTSIDE\n');
  });

  it('refuses to delete through a link that points outside the root', async () => {
    const { root, outside } = await fixture();
    const tool = createFileDeleteTool();
    await expect(tool.handler({ path: 'link-out.txt' }, ctx(root) as never))
      .rejects.toThrow(/path_forbidden|escapes/);
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
  });
});

describe('path containment: writes whose target does not exist yet', () => {
  it('refuses a new file under a link directory escaping the root', async () => {
    const { root, outside } = await fixture();
    const tool = createFileWriteTool();
    await expect(tool.handler({ path: 'dir-out/new.txt', content: 'X' }, ctx(root) as never))
      .rejects.toThrow(/path_forbidden|escapes/);
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
  });

  it('allows a new file under a normal directory inside the root', async () => {
    const { root } = await fixture();
    const tool = createFileWriteTool();
    await tool.handler({ path: 'sub/new.txt', content: 'OK' }, ctx(root) as never);
    expect(await readFile(join(root, 'sub', 'new.txt'), 'utf8')).toBe('OK');
  });

  it('never returns content outside the root through a link-plus-dotdot path', async () => {
    // `dir-out` is a link to the outside dir. Walking `dir-out/..` in a real
    // kernel enters the link target first, so this shape is a classic escape.
    // Lexical resolve() folds `..` before any fs call, which lands the request
    // on a non-existent path *inside* the root, so the observed failure may be
    // ENOENT rather than a policy rejection. The invariant that matters is the
    // same either way: the outside payload must never come back.
    const { root } = await fixture();
    const tool = createFileReadTool();
    let observed = '';
    try {
      observed = JSON.stringify(
        await tool.handler({ path: 'dir-out/../outside/secret.txt', summarize: 'off' }, ctx(root) as never),
      );
    } catch (error) {
      observed = error instanceof Error ? error.message : String(error);
    }
    expect(observed).not.toContain('SECRET-OUTSIDE');
  });
});

describe('path containment: attachment roots are contained too', () => {
  it('refuses an attachment-root link that escapes the attachment root', async () => {
    const { base, outside } = await fixture();
    const attachments = join(base, 'attachments');
    await mkdir(attachments, { recursive: true });
    await symlink(join(outside, 'secret.txt'), join(attachments, 'escape.txt'));

    // Readable path resolution over attachments must not bypass containment.
    expect(() =>
      resolveReadableToolPath('escape.txt', base, [attachments], {
        allowRoots: [attachments],
        containment: 'strict',
      }),
    ).toThrow(/path_forbidden|escapes/);
  });
});

describe('path containment: existing policy semantics stay intact', () => {
  it('strict with no roots still fails closed', async () => {
    const { root } = await fixture();
    expect(() =>
      resolveToolPath('inside.txt', root, { allowRoots: [], containment: 'strict' }),
    ).toThrow(/path_forbidden/);
  });

  it('soft lets an outside path through and keeps the lexical answer', async () => {
    const { root, outside } = await fixture();
    const resolved = resolveToolPath(join(outside, 'secret.txt'), root, {
      allowRoots: [root],
      containment: 'soft',
    });
    expect(resolved).toContain('secret.txt');
  });

  it('none passes through without realpath rewriting', async () => {
    const { root } = await fixture();
    const resolved = resolveToolPath('inside.txt', root, { containment: 'none' });
    expect(resolved).toBe(join(root, 'inside.txt'));
  });

  it('still answers containment for transaction accounting', async () => {
    const { root } = await fixture();
    // Used by file_write/file_edit/file_delete to decide "auto-allow, journaled"
    // versus "ask the host". It must agree with resolveToolPath's real paths.
    expect(isPathUnderRoots(join(root, 'x.txt'), [root])).toBe(true);
    expect(isPathUnderRoots('/definitely/elsewhere/x.txt', [root])).toBe(false);
  });
});

describe('path containment: dangling symlinks (review B1)', () => {
  it('refuses a final-component symlink whose target does not exist', async () => {
    // realpathSync raises ENOENT for the whole path *and* for the link itself is
    // not followed, so a missing-target link looks exactly like a missing name.
    // If it is treated as "just a new file", the following write follows the
    // link and creates the file outside the root.
    const { root, outside } = await fixture();
    await symlink(join(outside, 'not-yet.txt'), join(root, 'dangling.txt'));

    expect(() =>
      resolveToolPath('dangling.txt', root, { allowRoots: [root], containment: 'strict' }),
    ).toThrow(/path_forbidden|escapes/);

    // And the tool must not create the target either.
    const tool = createFileWriteTool();
    await expect(tool.handler({ path: 'dangling.txt', content: 'X' }, ctx(root) as never))
      .rejects.toThrow(/path_forbidden|escapes/);
    expect(existsSync(join(outside, 'not-yet.txt'))).toBe(false);
  });

  it('refuses a dangling link in an intermediate segment', async () => {
    const { root, outside } = await fixture();
    await symlink(join(outside, 'missing-dir'), join(root, 'dangling-dir'));

    expect(() =>
      resolveToolPath('dangling-dir/new.txt', root, { allowRoots: [root], containment: 'strict' }),
    ).toThrow(/path_forbidden|escapes/);
  });
});

describe('path containment: alias roots on the write-protection guards (review M2)', () => {
  it('attachment-root guard stays closed when the root is an alias', async () => {
    const { base } = await fixture();
    const attachments = join(base, 'attachments');
    await mkdir(attachments, { recursive: true });
    // The guard receives a real path (what resolveToolPath now returns) while
    // the configured root keeps its lexical spelling.
    const realFile = join(await realpath(attachments), 'a.txt');
    await writeFile(realFile, 'x');
    expect(isUnderAttachmentRoot(realFile, [attachments])).toBe(true);
  });

  it('session undo-root guard stays closed when the root is an alias', async () => {
    const { base } = await fixture();
    const sessions = join(base, 'sessions', 's1', 'undo');
    await mkdir(sessions, { recursive: true });
    const realUndo = await realpath(sessions);
    expect(isUnderSessionUndoRoot(join(realUndo, 'log.jsonl'), [sessions])).toBe(true);
  });
});
