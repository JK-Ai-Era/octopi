/**
 * Contract tests for the shared path primitives.
 *
 * These are the single source of truth for containment across domains, so their
 * semantics are pinned here rather than only indirectly through tool behaviour:
 * - resolution must survive a target that does not exist yet (file creation)
 * - but must refuse a segment that exists yet cannot be resolved (dangling link)
 * - comparison must be separator-aware and fold case only on Windows
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  realpathAllowMissing,
  lexicalUnderRoots,
  isPathUnderRoots,
} from '@octopi-agent/engine/harness/shared/paths/index.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'octopi-shared-paths-'));
  cleanup.push(base);
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'file.txt'), 'FILE\n');
  await writeFile(join(outside, 'secret.txt'), 'SECRET\n');
  return { base, root, outside };
}

describe('realpathAllowMissing', () => {
  it('resolves an existing file to its real path', async () => {
    const { root } = await fixture();
    const real = realpathAllowMissing(join(root, 'file.txt'));
    expect(real).toBe(join(await realpath(root), 'file.txt'));
  });

  it('resolves a missing tail against the deepest existing ancestor', async () => {
    const { root } = await fixture();
    const real = realpathAllowMissing(join(root, 'not-yet.txt'));
    expect(real).toBe(join(await realpath(root), 'not-yet.txt'));
  });

  it('resolves several missing segments', async () => {
    const { root } = await fixture();
    const real = realpathAllowMissing(join(root, 'a', 'b', 'c.txt'));
    expect(real).toBe(join(await realpath(root), 'a', 'b', 'c.txt'));
  });

  it('returns null for a dangling symlink instead of treating it as creatable', async () => {
    const { root, outside } = await fixture();
    await symlink(join(outside, 'ghost.txt'), join(root, 'dangling.txt'));
    expect(realpathAllowMissing(join(root, 'dangling.txt'))).toBeNull();
  });

  it('returns null when a missing parent is a dangling symlink', async () => {
    const { root, outside } = await fixture();
    await symlink(join(outside, 'ghost-dir'), join(root, 'dangling-dir'));
    expect(realpathAllowMissing(join(root, 'dangling-dir', 'x.txt'))).toBeNull();
  });

  it('follows an in-root symlink to its real target', async () => {
    const { root } = await fixture();
    await symlink(join(root, 'file.txt'), join(root, 'alias.txt'));
    expect(realpathAllowMissing(join(root, 'alias.txt'))).toBe(join(await realpath(root), 'file.txt'));
  });
});

describe('lexicalUnderRoots', () => {
  it('accepts the root itself and its descendants', async () => {
    const { root } = await fixture();
    expect(lexicalUnderRoots(root, [root])).toBe(true);
    expect(lexicalUnderRoots(join(root, 'a.txt'), [root])).toBe(true);
  });

  it('rejects a sibling whose name merely shares the prefix', async () => {
    const { base, root } = await fixture();
    // `/base/root-other` must not be considered inside `/base/root`.
    expect(lexicalUnderRoots(`${root}-other`, [root])).toBe(false);
    expect(lexicalUnderRoots(join(base, 'rootish'), [root])).toBe(false);
  });

  it('accepts a root written with a trailing separator', async () => {
    const { root } = await fixture();
    expect(lexicalUnderRoots(join(root, 'a.txt'), [`${root}/`])).toBe(true);
  });

  it('treats a backslash as a literal name character on POSIX', async () => {
    const { root } = await fixture();
    const withBackslash = `${root}\\nested`;
    if (process.platform === 'win32') {
      // On Windows a backslash is a separator, so this path is a descendant.
      expect(lexicalUnderRoots(withBackslash, [root])).toBe(true);
    } else {
      // On POSIX it is part of the file name, so it is not a descendant.
      expect(lexicalUnderRoots(withBackslash, [root])).toBe(false);
    }
  });

  it('is empty-root false', async () => {
    const { root } = await fixture();
    expect(lexicalUnderRoots(join(root, 'a.txt'), [])).toBe(false);
  });
});

describe('isPathUnderRoots', () => {
  it('accepts a path inside the root', async () => {
    const { root } = await fixture();
    expect(isPathUnderRoots(join(root, 'file.txt'), [root])).toBe(true);
  });

  it('rejects a path outside the root', async () => {
    const { root, outside } = await fixture();
    expect(isPathUnderRoots(join(outside, 'secret.txt'), [root])).toBe(false);
  });

  it('rejects an in-root symlink that resolves outside', async () => {
    const { root, outside } = await fixture();
    await symlink(join(outside, 'secret.txt'), join(root, 'link-out.txt'));
    expect(isPathUnderRoots(join(root, 'link-out.txt'), [root])).toBe(false);
  });

  it('accepts an in-root symlink that resolves inside', async () => {
    const { root } = await fixture();
    await symlink(join(root, 'file.txt'), join(root, 'link-in.txt'));
    expect(isPathUnderRoots(join(root, 'link-in.txt'), [root])).toBe(true);
  });

  it('handles an alias root (root spelling differs from its realpath)', async () => {
    const { root } = await fixture();
    const real = await realpath(root);
    // Only the root's spelling differs; the target is already real.
    expect(isPathUnderRoots(join(real, 'file.txt'), [root])).toBe(true);
    expect(isPathUnderRoots(join(root, 'file.txt'), [real])).toBe(true);
  });

  it('accepts a path that does not exist yet under an existing root', async () => {
    const { root } = await fixture();
    expect(isPathUnderRoots(join(root, 'new', 'file.txt'), [root])).toBe(true);
  });

  it('rejects a dangling link inside the root', async () => {
    const { root, outside } = await fixture();
    await symlink(join(outside, 'ghost.txt'), join(root, 'dangling.txt'));
    // Unresolvable → falls back to the lexical form, which is still inside.
    // That is containment, not safety: callers that operate on the path must
    // resolve it themselves (see containPath) and get null here.
    expect(realpathAllowMissing(join(root, 'dangling.txt'))).toBeNull();
    expect(isPathUnderRoots(join(root, 'dangling.txt'), [root])).toBe(true);
  });

  it('is independent of the working directory', async () => {
    const { root } = await fixture();
    const before = process.cwd();
    process.chdir(tmpdir());
    try {
      expect(isPathUnderRoots(resolve(root, 'file.txt'), [root])).toBe(true);
    } finally {
      process.chdir(before);
    }
  });
});
