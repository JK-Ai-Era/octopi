/**
 * `pathDenylist` must hold on every content-bearing surface, not just on the
 * path argument of `file_read`.
 *
 * An earlier revision applied the list only where a caller *names* a path, which
 * left three holes: `file_search` returned the contents of a denied file,
 * `file_list` enumerated denied names, and `git diff`/`git show` emitted denied
 * content through section bodies the caller never named. Those are covered here,
 * together with the shapes that looked protected but were not (Windows
 * separators, `pathContainment: 'none'`, attachment roots).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createFileListTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/builtin.js';
import { createFileSearchTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/file-search.js';
import {
  createGitDiffTool,
  createGitStatusTool,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/git-tools.js';
import { resolveReadableToolPath, resolveToolPath } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/platform.js';
import {
  matchesDenyPattern,
  validateDenyPattern,
} from '@octopi-agent/engine/harness/shared/paths/glob.js';
import { EffectPolicyConfigSchema } from '@octopi-agent/engine/config-schema/governance.js';
import { makeToolContext } from '../helpers/tool-context.js';

const run = promisify(execFile);

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

const PATTERNS = ['.env*', '*.pem', 'id_rsa*'];

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'octopi-deny-cover-'));
  cleanup.push(base);
  const root = join(base, 'root');
  await mkdir(join(root, 'pkg'), { recursive: true });
  await writeFile(join(root, '.env'), 'LEAKED_SECRET=1\n');
  await writeFile(join(root, 'server.pem'), 'LEAKED_PEM\n');
  await writeFile(join(root, 'pkg', 'index.ts'), 'export const ok = 1;\n');
  return { base, root };
}

interface CtxOptions {
  denylist?: string[];
  containment?: 'strict' | 'soft' | 'none';
}

function ctx(root: string, options: CtxOptions = {}) {
  return makeToolContext({
    cwd: root,
    pathRoots: [root],
    pathContainment: options.containment ?? 'strict',
    pathDenylist: options.denylist ?? PATTERNS,
    effectChannel: 'engine',
  });
}

describe('file_search', () => {
  it('does not return the contents of a denied file', async () => {
    const { root } = await fixture();
    const tool = createFileSearchTool();
    const result = await tool.handler({ path: root, pattern: 'LEAKED_SECRET' }, ctx(root)) as {
      matches: Array<{ file: string }>;
      totalMatches: number;
    };
    expect(result.totalMatches).toBe(0);
    expect(result.matches).toEqual([]);
  });

  it('still searches allowed files next to denied ones', async () => {
    const { root } = await fixture();
    const tool = createFileSearchTool();
    const result = await tool.handler({ path: root, pattern: 'ok = 1' }, ctx(root)) as {
      matches: Array<{ file: string }>;
      totalMatches: number;
    };
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0]?.file).toContain('index.ts');
  });

  it('searches denied files when the list is empty (default unchanged)', async () => {
    const { root } = await fixture();
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { path: root, pattern: 'LEAKED_SECRET' },
      ctx(root, { denylist: [] }),
    ) as { totalMatches: number };
    expect(result.totalMatches).toBeGreaterThan(0);
  });
});

describe('file_list', () => {
  it('does not enumerate denied names', async () => {
    const { root } = await fixture();
    const tool = createFileListTool();
    const result = await tool.handler({ path: root, recursive: true }, ctx(root)) as {
      entries: Array<{ name: string }>;
    };
    const names = result.entries.map((entry) => entry.name);
    expect(names).not.toContain('.env');
    expect(names).not.toContain('server.pem');
    expect(names).toContain('index.ts');
  });
});

describe('git channel', () => {
  async function gitFixture() {
    const { root } = await fixture();
    const git = (...args: string[]) =>
      run('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd: root });
    await git('init', '-q');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'init');
    // Modify both a denied and an allowed tracked file so the diff has sections.
    await writeFile(join(root, '.env'), 'LEAKED_SECRET=2\n');
    await writeFile(join(root, 'pkg', 'index.ts'), 'export const ok = 2;\n');
    return { root, git };
  }

  it('git_status hides denied paths', async () => {
    const { root } = await gitFixture();
    const tool = createGitStatusTool();
    const result = await tool.handler({}, ctx(root)) as { stdout: string };
    expect(result.stdout).toContain('pkg/index.ts');
    expect(result.stdout).not.toContain('.env');
  });

  it('git_diff drops the section body of a denied file', async () => {
    const { root } = await gitFixture();
    const tool = createGitDiffTool();
    const result = await tool.handler({}, ctx(root)) as { stdout: string };
    expect(result.stdout).toContain('pkg/index.ts');
    expect(result.stdout).not.toContain('LEAKED_SECRET');
  });

  it('git_diff keeps denied sections when the list is empty', async () => {
    const { root } = await gitFixture();
    const tool = createGitDiffTool();
    const result = await tool.handler({}, ctx(root, { denylist: [] })) as { stdout: string };
    expect(result.stdout).toContain('LEAKED_SECRET');
  });

  it('refuses an unverifiable glob pathspec while a denylist is active', async () => {
    const { root } = await gitFixture();
    const tool = createGitDiffTool();
    await expect(
      tool.handler({ paths: ['*.ts'] }, ctx(root)),
    ).rejects.toThrow(/pathspec_glob_forbidden/);
  });
});

describe('resolved-target and root checks', () => {
  it('denies a link target under containment none', async () => {
    const { root } = await fixture();
    await symlink(join(root, '.env'), join(root, 'notes.txt'));
    expect(() =>
      resolveToolPath('notes.txt', root, { containment: 'none', denyPatterns: PATTERNS }),
    ).toThrow(/pathDenylist/);
  });

  it('denies a link target that escapes the root under soft containment', async () => {
    const { base, root } = await fixture();
    await writeFile(join(base, '.env'), 'LEAKED_SECRET=3\n');
    await symlink(join(base, '.env'), join(root, 'notes.txt'));
    expect(() =>
      resolveToolPath('notes.txt', root, { allowRoots: [root], containment: 'soft', denyPatterns: PATTERNS }),
    ).toThrow(/pathDenylist/);
  });
});

describe('attachment roots', () => {
  it('applies the denylist to attachment reads', async () => {
    const { base, root } = await fixture();
    const attachments = join(base, 'attachments');
    await mkdir(attachments, { recursive: true });
    await writeFile(join(attachments, 'id_rsa'), 'LEAKED_KEY\n');
    expect(() =>
      resolveReadableToolPath('id_rsa', root, [attachments], {
        allowRoots: [root],
        containment: 'strict',
        denyPatterns: PATTERNS,
      }),
    ).toThrow(/pathDenylist/);
  });
});

describe('pattern shapes', () => {
  it('treats a backslash as a separator (Windows spelling)', () => {
    expect(matchesDenyPattern('pkg/.git/config', ['.git\\**'])).toBe(true);
  });

  it('rejects shapes that can never match', () => {
    expect(() => validateDenyPattern('')).toThrow(/non-empty/);
    expect(() => validateDenyPattern('/etc/passwd')).toThrow(/root-relative/);
    expect(() => validateDenyPattern('.git/')).toThrow(/separator/);
    expect(() => validateDenyPattern('../.env')).toThrow(/segments/);
  });

  it('fails config validation at load time, not on the first turn', () => {
    expect(EffectPolicyConfigSchema.safeParse({ pathDenylist: ['.env*'] }).success).toBe(true);
    const parsed = EffectPolicyConfigSchema.safeParse({ pathDenylist: ['/.env'] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain('root-relative');
    }
  });
});
