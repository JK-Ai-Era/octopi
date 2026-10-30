/**
 * Path containment primitives — shared by tool execution and effect auditing
 *
 * Containment is a cross-cutting mechanism, not a policy owned by one domain:
 * the tools domain decides *what* may be touched (`pathRoots`, `containment`),
 * while the execution-environment domain decides *what gets recorded*. Both
 * need the same answer to "is this path under that root", and both need it in
 * real coordinates — a purely lexical comparison lets a symlink inside a root
 * reach outside it.
 *
 * These helpers live in `shared/` so that no domain has to import another
 * domain's internals to get correct containment. They are foundation code:
 * no policy defaults, no product decisions.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * Resolve a path that may not exist yet to its real location.
 *
 * `realpathSync` throws for a missing target, but creating a new file is a
 * normal operation. Walk up to the deepest existing ancestor, resolve that,
 * and re-append the remaining segments. `resolve()` already folded `..`, so the
 * appended tail cannot introduce a new escape.
 *
 * A missing segment that *does* exist as a directory entry is not treated as
 * "about to be created": that is a dangling symlink or a link loop, and letting
 * it through would allow the following open/write to follow it out of the root.
 * `lstatSync` does not follow the final component, which separates the cases.
 *
 * @param abs - absolute, lexically normalized path
 * @returns real path, or null when it cannot be resolved safely
 */
export function realpathAllowMissing(abs: string): string | null {
  let current = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length ? join(real, ...tail) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      if (existsLstat(current)) return null;
      const parent = dirname(current);
      if (parent === current) return null;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Whether anything exists at this path, without following a final symlink.
 *
 * @param path - absolute path
 * @returns true when an entry exists (including a dangling link)
 */
function existsLstat(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Containment over already-normalized paths (no filesystem access).
 *
 * Use this only when both sides are already real paths; otherwise prefer
 * {@link isPathUnderRoots}, which resolves them first.
 *
 * Windows drive letters are compared case-insensitively, matching how the
 * effect policy treats volume names.
 *
 * @param absPath - path already resolved to its real form
 * @param roots - roots already resolved to their real form
 * @returns whether the path is one of the roots or under one
 */
export function lexicalUnderRoots(absPath: string, roots: string[]): boolean {
  const win = process.platform === 'win32';
  const norm = (s: string) => (win ? s.toLowerCase() : s);
  const target = norm(absPath);
  return roots.some((root) => {
    const r = norm(root);
    return target === r || target.startsWith(r.endsWith(sep) ? r : r + sep);
  });
}

/**
 * Whether a path falls under any of the given roots, in real coordinates.
 *
 * Both sides are resolved: comparing a resolved target against an unresolved
 * root would wrongly deny legitimate paths whenever the root is itself an alias
 * (macOS `/var` → `/private/var`, a symlinked `$HOME`). A path that cannot be
 * resolved falls back to its lexical form, so this only ever answers "is it
 * inside", never "is it safe to operate on" — callers that need the resolved
 * path must use their own resolution step.
 *
 * @param absPath - path to test
 * @param roots - allowed roots
 * @returns true when the path is one of the roots or under one
 */
export function isPathUnderRoots(absPath: string, roots: readonly string[]): boolean {
  const lexical = roots.map((root) => resolve(root));
  const target = resolve(absPath);
  const real = (s: string) => realpathAllowMissing(s) ?? s;

  const realTarget = realpathAllowMissing(target);
  if (realTarget !== null) {
    // Compare in real coordinates: a resolved target against an unresolved root
    // would deny legitimate paths whenever the root is itself an alias.
    return lexicalUnderRoots(realTarget, lexical.map(real));
  }
  // The target exists but cannot be resolved (dangling symlink or link loop).
  // Comparing a lexical target against resolved roots would mix coordinate
  // systems and report an in-root link as outside. Stay lexical on both sides.
  // This answers containment only; callers that act on the path must take
  // realpathAllowMissing's null and refuse, which is what containPath does.
  return lexicalUnderRoots(target, lexical);
}

/**
 * Whether the final path component is a symbolic link, without following it.
 *
 * `lstat` inspects the entry itself, so a dangling link still reports `true` —
 * which is what a write guard needs: an unresolvable link is exactly the case
 * where a later open would follow it somewhere unintended.
 *
 * @param path - path to inspect
 * @returns true when the entry exists and is a symlink
 */
export function isFinalSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    // ENOENT / ENOTDIR: nothing at that name, so nothing to follow.
    return false;
  }
}

/**
 * Read a file refusing to traverse a symlink at the final component.
 *
 * Resolving containment already returns a real path, so normally the final
 * component is not a link. If it is one at open time, something replaced it
 * between the containment check and this open; `O_NOFOLLOW` makes the kernel
 * refuse instead of following it (`ELOOP`).
 *
 * @param path - absolute path, normally already resolved
 * @param encoding - text encoding
 * @returns file contents
 */
export async function readFileNoFollow(path: string, encoding: 'utf8'): Promise<string> {
  const { open, constants } = await import('node:fs/promises');
  // O_NOFOLLOW is POSIX-only. On Windows it is absent, and `0 | undefined` is
  // `0` — which would silently mean "follow the link", the opposite of intent.
  // Fall back to an lstat pre-check there: it keeps refusing dangling links
  // (the common planted case) at the cost of a narrower TOCTOU window.
  if (constants.O_NOFOLLOW === undefined) {
    if (isFinalSymlink(path)) {
      throw new Error(`path_forbidden: "${path}" final component is a symlink (no O_NOFOLLOW on this platform)`);
    }
    const handle = await open(path, 'r');
    try {
      return await handle.readFile({ encoding });
    } finally {
      await handle.close();
    }
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile({ encoding });
  } finally {
    await handle.close();
  }
}
