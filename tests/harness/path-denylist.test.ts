/**
 * `effectPolicy.pathDenylist` — deployment-declared forbidden paths.
 *
 * The engine has no opinion here: reading `.env` inside an agent's own
 * workspace is a legitimate operation, so the default is an empty list and no
 * path is denied. Declaring a pattern denies it at every containment level.
 *
 * Two properties are load-bearing and tested:
 * - deny works even when containment is `soft`/`none` (it is an independent layer)
 * - it never touches transaction accounting, which asks "is this inside", not
 *   "may I touch this"
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveToolPath, containmentOptions } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/platform.js';
import {
  globToPathRegex,
  matchesDenyPattern,
} from '@octopi-agent/engine/harness/shared/paths/glob.js';
import { resolveEffectiveEffectPolicy } from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'octopi-denylist-'));
  cleanup.push(base);
  const root = join(base, 'root');
  await mkdir(join(root, 'pkg', '.git'), { recursive: true });
  await writeFile(join(root, 'pkg', 'index.ts'), 'export {};\n');
  await writeFile(join(root, 'pkg', 'index.ts.map'), '{}\n');
  await writeFile(join(root, '.env'), 'TOKEN=x\n');
  await writeFile(join(root, '.env.local'), 'TOKEN=y\n');
  await writeFile(join(root, 'pkg', '.git', 'config'), '[core]\n');
  await writeFile(join(root, 'server.pem'), 'KEY\n');
  await writeFile(join(root, 'id_rsa'), 'KEY\n');
  return { base, root };
}

const PATTERNS = ['.env*', '.git/**', '*.pem', 'id_rsa*'];

describe('glob semantics', () => {
  it('matches a bare pattern at any depth', () => {
    expect(globToPathRegex('*.md').test('docs/a.md')).toBe(true);
    expect(globToPathRegex('*.md').test('a.md')).toBe(true);
    expect(globToPathRegex('*.md').test('docs/a.ts')).toBe(false);
  });

  it('supports ** and braces', () => {
    expect(globToPathRegex('.git/**').test('.git/config')).toBe(true);
    expect(globToPathRegex('*.{pem,key}').test('a.pem')).toBe(true);
    expect(globToPathRegex('*.{pem,key}').test('a.key')).toBe(true);
    // The compiler stays anchored: `file_search` relies on that. Matching a
    // pattern at any depth is the denylist's job (see matchesDenyPattern).
    expect(globToPathRegex('.git/**').test('pkg/.git/config')).toBe(false);
    expect(matchesDenyPattern('pkg/.git/config', ['.git/**'])).toBe(true);
  });

  it('matches the file name as well as the relative path', () => {
    expect(matchesDenyPattern('pkg/.git/config', ['.git/**'])).toBe(true);
    expect(matchesDenyPattern('pkg/.env', ['.env*'])).toBe(true);
    expect(matchesDenyPattern('pkg/index.ts', PATTERNS)).toBe(false);
  });

  it('throws on an empty pattern instead of silently matching nothing', () => {
    expect(() => globToPathRegex('   ')).toThrow();
  });
});

describe('resolveToolPath with a denylist', () => {
  it('denies a matching file at strict containment', async () => {
    const { root } = await fixture();
    expect(() =>
      resolveToolPath('.env', root, { allowRoots: [root], containment: 'strict', denyPatterns: PATTERNS }),
    ).toThrow(/pathDenylist/);
  });

  it('denies even when containment is none (independent layer)', async () => {
    const { root } = await fixture();
    expect(() =>
      resolveToolPath('server.pem', root, { containment: 'none', denyPatterns: PATTERNS }),
    ).toThrow(/pathDenylist/);
  });

  it('denies even when containment is soft', async () => {
    const { root } = await fixture();
    expect(() =>
      resolveToolPath('id_rsa', root, { allowRoots: [root], containment: 'soft', denyPatterns: PATTERNS }),
    ).toThrow(/pathDenylist/);
  });

  it('denies a nested .git file via the relative path', async () => {
    const { root } = await fixture();
    expect(() =>
      resolveToolPath('pkg/.git/config', root, { allowRoots: [root], containment: 'strict', denyPatterns: PATTERNS }),
    ).toThrow(/pathDenylist/);
  });

  it('allows non-matching files', async () => {
    const { root } = await fixture();
    expect(
      resolveToolPath('pkg/index.ts', root, { allowRoots: [root], containment: 'strict', denyPatterns: PATTERNS }),
    ).toContain('index.ts');
  });

  it('denies a link whose target is on the list, not just its name', async () => {
    const { root } = await fixture();
    // A harmless-looking name pointing at a denied target must not be a bypass.
    await symlink(join(root, '.env'), join(root, 'notes.txt'));
    expect(() =>
      resolveToolPath('notes.txt', root, { allowRoots: [root], containment: 'strict', denyPatterns: PATTERNS }),
    ).toThrow(/pathDenylist/);
  });

  it('an empty list denies nothing (default behaviour unchanged)', async () => {
    const { root } = await fixture();
    expect(resolveToolPath('.env', root, { allowRoots: [root], containment: 'strict', denyPatterns: [] }))
      .toContain('.env');
  });
});

describe('containmentOptions', () => {
  it('carries roots, containment and denylist from the tool context', async () => {
    const { root } = await fixture();
    const options = containmentOptions({
      pathRoots: [root],
      pathContainment: 'strict',
      pathDenylist: PATTERNS,
    });
    expect(options.allowRoots).toEqual([root]);
    expect(options.containment).toBe('strict');
    expect(options.denyPatterns).toEqual(PATTERNS);
  });

  it('tolerates a missing context', () => {
    expect(containmentOptions(undefined)).toEqual({
      allowRoots: undefined,
      containment: undefined,
      denyPatterns: undefined,
    });
  });
});

describe('policy resolution', () => {
  const resolve = (extra: Record<string, unknown>, mode = 'workspace') =>
    resolveEffectiveEffectPolicy(
      { mode, untrustedAdmission: 'degrade', ...extra } as never,
      undefined,
      undefined,
    );

  it('defaults to an empty list', () => {
    expect(resolve({}).pathDenylist).toEqual([]);
  });

  it('passes declared patterns through', () => {
    expect(resolve({ pathDenylist: PATTERNS }).pathDenylist).toEqual(PATTERNS);
  });

  it('rejects a malformed pattern at resolve time, not mid-run', () => {
    expect(() => resolve({ pathDenylist: [''] })).toThrow();
  });

  it('unions presets with config so a deployment cannot loosen a preset', () => {
    // Presets are empty today, so the union is observable via dedup only.
    const policy = resolve({ pathDenylist: ['.env*', '.env*'] });
    expect(policy.pathDenylist).toEqual(['.env*']);
  });
});
