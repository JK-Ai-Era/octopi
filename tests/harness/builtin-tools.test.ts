import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { createFileEditTool } from '../../src/harness/plugin-ecosystem/tools/file-edit.js';
import { createFileSearchTool } from '../../src/harness/plugin-ecosystem/tools/file-search.js';
import { createEnvInfoTool } from '../../src/harness/plugin-ecosystem/tools/env-info.js';
import { getBuiltinTools } from '../../src/harness/plugin-ecosystem/tools/builtin.js';
import type { ToolExecutionContext } from '../../src/core/types/tools.js';

function makeContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    sessionId: 'test-session',
    agentId: 'test-agent',
    messages: [],
    ...overrides,
  };
}

// ── file_edit ──

describe('file_edit', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `octopi-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should replace the first occurrence by default', async () => {
    const filePath = join(tmpDir, 'test.txt');
    await writeFile(filePath, 'hello world\nhello again\nhello last');

    const tool = createFileEditTool();
    const result = await tool.handler(
      { path: filePath, old_text: 'hello', new_text: 'hi' },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.matchCount).toBe(3);
    expect(result.replacedCount).toBe(1);

    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('hi world\nhello again\nhello last');
  });

  it('should replace all occurrences when occurrence=all', async () => {
    const filePath = join(tmpDir, 'test.txt');
    await writeFile(filePath, 'aaa bbb aaa ccc aaa');

    const tool = createFileEditTool();
    await tool.handler(
      { path: filePath, old_text: 'aaa', new_text: 'xxx', occurrence: 'all' },
      makeContext({ cwd: tmpDir }),
    );

    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('xxx bbb xxx ccc xxx');
  });

  it('should replace the last occurrence', async () => {
    const filePath = join(tmpDir, 'test.txt');
    await writeFile(filePath, 'line1\nline2\nline3');

    const tool = createFileEditTool();
    await tool.handler(
      { path: filePath, old_text: 'line', new_text: 'row', occurrence: 'last' },
      makeContext({ cwd: tmpDir }),
    );

    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('line1\nline2\nrow3');
  });

  it('should replace the Nth occurrence', async () => {
    const filePath = join(tmpDir, 'test.txt');
    await writeFile(filePath, 'a x a x a x');

    const tool = createFileEditTool();
    await tool.handler(
      { path: filePath, old_text: 'a', new_text: 'b', occurrence: '2' },
      makeContext({ cwd: tmpDir }),
    );

    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('a x b x a x');
  });

  it('should support dry_run without modifying file', async () => {
    const filePath = join(tmpDir, 'test.txt');
    const original = 'hello world';
    await writeFile(filePath, original);

    const tool = createFileEditTool();
    const result = await tool.handler(
      { path: filePath, old_text: 'hello', new_text: 'hi', dry_run: true },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.dryRun).toBe(true);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe(original);
  });

  it('should throw when old_text not found', async () => {
    const filePath = join(tmpDir, 'test.txt');
    await writeFile(filePath, 'nothing here');

    const tool = createFileEditTool();
    await expect(
      tool.handler(
        { path: filePath, old_text: 'MISSING', new_text: 'x' },
        makeContext({ cwd: tmpDir }),
      ),
    ).rejects.toThrow('old_text not found');
  });

  it('should throw for invalid occurrence number', async () => {
    const filePath = join(tmpDir, 'test.txt');
    await writeFile(filePath, 'one match only');

    const tool = createFileEditTool();
    await expect(
      tool.handler(
        { path: filePath, old_text: 'match', new_text: 'x', occurrence: '5' },
        makeContext({ cwd: tmpDir }),
      ),
    ).rejects.toThrow('Invalid occurrence');
  });
});

// ── file_search ──

describe('file_search', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `octopi-test-${randomUUID()}`);
    await mkdir(join(tmpDir, 'sub'), { recursive: true });
    await writeFile(join(tmpDir, 'a.ts'), 'const foo = 1;\nconst bar = 2;');
    await writeFile(join(tmpDir, 'b.js'), 'let foo = 3;');
    await writeFile(join(tmpDir, 'sub', 'c.ts'), 'function baz() { return foo; }');
    await writeFile(join(tmpDir, 'binary.png'), Buffer.from([0x89, 0x50]));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should find text matches across files', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'foo', path: tmpDir },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.matches.length).toBe(3);
    expect(result.searchedFiles).toBeGreaterThan(0);
    const files = result.matches.map((m: any) => m.file).sort();
    expect(files).toContain('a.ts');
    expect(files).toContain('b.js');
    expect(files).toContain('sub/c.ts');
  });

  it('should filter by glob pattern', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'foo', path: tmpDir, glob: '*.ts' },
      makeContext({ cwd: tmpDir }),
    ) as any;

    const files = result.matches.map((m: any) => m.file);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f: string) => f.endsWith('.ts'))).toBe(true);
  });

  it('should support regex search', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'const \\w+ =', path: tmpDir, regex: true },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.matches.length).toBe(2);
    expect(result.diagnostics.patternMode).toBe('regex');
  });

  it('should auto-detect regex without pattern_mode', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: '^const \\w+', path: tmpDir },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.diagnostics.patternMode).toBe('regex');
    expect(result.matches.length).toBe(2);
  });

  it('should treat code tokens as literal in auto mode', async () => {
    await writeFile(
      join(tmpDir, 'code.ts'),
      'const a = arr[0];\nuseState();\nconst s = a+b;\nlet x = C++;\nconst p = foo.bar;\n',
    );
    const tool = createFileSearchTool();

    for (const pattern of ['arr[0]', 'useState()', 'a+b', 'C++', 'foo.bar']) {
      const result = await tool.handler(
        { pattern, path: tmpDir, glob: 'code.ts' },
        makeContext({ cwd: tmpDir }),
      ) as any;
      expect(result.diagnostics.patternMode, pattern).toBe('literal');
      expect(result.totalMatches, pattern).toBe(1);
      expect(result.matches[0].content.includes(pattern), pattern).toBe(true);
    }
  });

  it('should treat bare * as literal by default', async () => {
    await writeFile(join(tmpDir, 'star.txt'), 'memory* should stay literal');
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'memory*', path: tmpDir },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.diagnostics.patternMode).toBe('literal');
    expect(result.matches.length).toBe(1);
  });

  it('should force literal via pattern_mode and hint on | patterns', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'foo|bar', path: tmpDir, pattern_mode: 'literal' },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.totalMatches).toBe(0);
    expect(result.diagnostics.patternMode).toBe('literal');
    expect(result.hints.some((h: string) => h.includes('forced to literal'))).toBe(true);
  });

  it('should hint pattern_mode=literal when auto regex finds nothing', async () => {
    await writeFile(join(tmpDir, 'x.txt'), 'plain text only');
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'arr\\[0\\]', path: tmpDir },
      makeContext({ cwd: tmpDir }),
    ) as any;

    // has regex escapes → auto=regex, no hits against 'plain text only'
    expect(result.diagnostics.patternMode).toBe('regex');
    expect(result.totalMatches).toBe(0);
    expect(result.hints.some((h: string) => h.includes('pattern_mode="literal"'))).toBe(true);
  });

  it('should hint when glob hits only skipped files', async () => {
    await mkdir(join(tmpDir, 'img'), { recursive: true });
    await writeFile(join(tmpDir, 'img', 'a.png'), Buffer.from([0x89, 0x50]));
    await writeFile(join(tmpDir, 'img', 'b.png'), Buffer.from([0x89, 0x50]));
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'foo', path: tmpDir, glob: 'img/*.png' },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.totalMatches).toBe(0);
    expect(result.diagnostics.filesMatchedByGlob).toBe(2);
    expect(result.diagnostics.filesSearched).toBe(0);
    expect(result.hints.some((h: string) => h.includes('skipped'))).toBe(true);
  });

  it('should search text files larger than 1MB via line stream', async () => {
    const big = join(tmpDir, 'big.log');
    const filler = 'x'.repeat(1000);
    const lines: string[] = [];
    for (let i = 0; i < 1200; i++) lines.push(`${i}:${filler}`);
    lines.push('NEEDLE_AT_END');
    await writeFile(big, lines.join('\n'));

    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'NEEDLE_AT_END', path: tmpDir, glob: 'big.log' },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.diagnostics.maxFileBytes).toBe(50_000_000);
    expect(result.diagnostics.filesSearched).toBe(1);
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0].content).toBe('NEEDLE_AT_END');
  });

  it('should skip files over max_file_bytes and hint to raise it', async () => {
    await writeFile(join(tmpDir, 'mid.txt'), 'a'.repeat(2000) + '\nNEEDLE');
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'NEEDLE', path: tmpDir, glob: 'mid.txt', max_file_bytes: 1000 },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.totalMatches).toBe(0);
    expect(result.diagnostics.filesSkippedOversize).toBe(1);
    expect(result.diagnostics.maxFileBytes).toBe(1000);
    expect(result.hints.some((h: string) => h.includes('max_file_bytes'))).toBe(true);
  });

  it('should OR multiple patterns', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { patterns: ['bar', 'does-not-exist'], path: tmpDir },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.matches.length).toBe(1);
    expect(result.matches[0].content).toContain('bar');
    expect(result.diagnostics.patterns).toEqual(['bar', 'does-not-exist']);
    expect(result.diagnostics.patternMode).toBe('literal');
  });

  it('should return context lines', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'bar', path: tmpDir, context_lines: 1 },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.matches.length).toBe(1);
    expect(result.matches[0].before).toBeDefined();
    expect(result.matches[0].before.length).toBe(1);
  });

  it('should respect max_results', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'foo', path: tmpDir, max_results: 1 },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.matches.length).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('should default to case-insensitive search', async () => {
    await writeFile(join(tmpDir, 'case.md'), '# Memory Search\n');
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'memory', path: tmpDir },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.matches.some((m: any) => m.file === 'case.md')).toBe(true);
  });

  it('should match path globs with ** against relative paths', async () => {
    const tool = createFileSearchTool();
    const starStar = await tool.handler(
      { pattern: 'foo', path: tmpDir, glob: '**/*.ts' },
      makeContext({ cwd: tmpDir }),
    ) as any;
    const bare = await tool.handler(
      { pattern: 'foo', path: tmpDir, glob: '*.ts' },
      makeContext({ cwd: tmpDir }),
    ) as any;
    const nested = await tool.handler(
      { pattern: 'foo', path: tmpDir, glob: '**/c.ts' },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(starStar.searchedFiles).toBe(bare.searchedFiles);
    expect(starStar.searchedFiles).toBe(2);
    expect(nested.matches.map((m: any) => m.file)).toEqual(['sub/c.ts']);
  });

  it('should not let single-star glob cross directories', async () => {
    await mkdir(join(tmpDir, 'sub', 'deep'), { recursive: true });
    await writeFile(join(tmpDir, 'sub', 'deep', 'd.ts'), 'const deep = 1;');

    const tool = createFileSearchTool();
    const bareName = await tool.handler(
      { pattern: 'foo', path: tmpDir, glob: 'c.ts' },
      makeContext({ cwd: tmpDir }),
    ) as any;
    const oneSegment = await tool.handler(
      { pattern: 'deep', path: tmpDir, glob: 'sub/*.ts' },
      makeContext({ cwd: tmpDir }),
    ) as any;
    const crossStar = await tool.handler(
      { pattern: 'deep', path: tmpDir, glob: 'sub/**/*.ts' },
      makeContext({ cwd: tmpDir }),
    ) as any;

    // bare name matches at any depth
    expect(bareName.matches.length).toBeGreaterThan(0);
    // `*` does not cross `/`
    expect(oneSegment.totalMatches).toBe(0);
    // `**` does
    expect(crossStar.matches.map((m: any) => m.file)).toEqual(['sub/deep/d.ts']);
  });

  it('should expand brace globs', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'foo', path: tmpDir, glob: '*.{ts,js}' },
      makeContext({ cwd: tmpDir }),
    ) as any;

    const files = result.matches.map((m: any) => m.file);
    expect(files.some((f: string) => f.endsWith('.ts'))).toBe(true);
    expect(files.some((f: string) => f.endsWith('.js'))).toBe(true);
    expect(files.every((f: string) => f.endsWith('.ts') || f.endsWith('.js'))).toBe(true);
  });

  it('should return diagnostics and hints when glob matches nothing', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'foo', path: tmpDir, glob: 'docs/**/*.md' },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.totalMatches).toBe(0);
    expect(result.diagnostics.filesSeen).toBeGreaterThan(0);
    expect(result.diagnostics.filesMatchedByGlob).toBe(0);
    expect(result.diagnostics.compiledGlob).toBeTruthy();
    expect(result.hints.length).toBeGreaterThan(0);
    expect(result.hints[0]).toContain('matched 0 files');
  });

  it('should throw when neither pattern nor patterns provided', async () => {
    const tool = createFileSearchTool();
    await expect(
      tool.handler({ path: tmpDir }, makeContext({ cwd: tmpDir })),
    ).rejects.toThrow('pattern');
  });
});

describe('file_search regression (openclaw-style misses)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `octopi-fs-reg-${randomUUID()}`);
    await mkdir(join(tmpDir, 'concepts'), { recursive: true });
    await mkdir(join(tmpDir, 'cli'), { recursive: true });
    await writeFile(
      join(tmpDir, 'concepts', 'memory-search.md'),
      '---\ntitle: memory-search\n---\n\n# Memory Search\n\n`memory_search` finds notes.\nSee memory config and memory-config.\n',
    );
    await writeFile(
      join(tmpDir, 'cli', 'memory.md'),
      '# `openclaw memory`\n\nmemory_search or memory_search tool.\n',
    );
    await writeFile(
      join(tmpDir, 'README.md'),
      '# Docs\n\nUse memory-search|memory_search together with memory config.\n',
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('case1: pipe alternation with *.md finds OR matches in auto mode', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      {
        case_sensitive: false,
        glob: '*.md',
        max_results: 30,
        path: tmpDir,
        pattern: 'memory-search|memory_search|memory config|memory-config',
      },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.diagnostics.patternMode).toBe('regex');
    expect(result.totalMatches).toBeGreaterThan(0);
    const files = new Set(result.matches.map((m: any) => m.file));
    expect(files.has('README.md')).toBe(true);
    expect(files.has('concepts/memory-search.md')).toBe(true);
  });

  it('case2: heading regex + **/*.md searches nested files', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      {
        case_sensitive: false,
        glob: '**/*.md',
        max_results: 30,
        path: tmpDir,
        pattern: '^#+ .*[Mm]emory',
      },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.diagnostics.filesSearched).toBeGreaterThan(0);
    expect(result.diagnostics.patternMode).toBe('regex');
    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.matches.some((m: any) => m.content.includes('Memory'))).toBe(true);
  });

  it('case3: **/memory*.md + heading anchor', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      {
        case_sensitive: false,
        glob: '**/memory*.md',
        max_results: 30,
        path: tmpDir,
        pattern: '^# ',
      },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.diagnostics.filesSearched).toBeGreaterThan(0);
    expect(result.totalMatches).toBeGreaterThan(0);
    const files = result.matches.map((m: any) => m.file);
    expect(files.some((f: string) => f.includes('memory'))).toBe(true);
  });
});

// ── env_info ──

describe('env_info', () => {
  it('should return environment info with expected fields', async () => {
    const tool = createEnvInfoTool();
    const result = await tool.handler({}, makeContext()) as any;

    expect(result.os).toBeDefined();
    expect(result.os.platform).toBe(process.platform);
    expect(result.node.version).toBe(process.version);
    expect(result.cwd).toBeDefined();
    expect(result.packageManagers).toBeDefined();
    expect(typeof result.packageManagers.npm).toBe('boolean');
    expect(result.platformShell).toBeDefined();
    expect(result.platformShell.kind).toBeTruthy();
  });
});

// ── getBuiltinTools ──

describe('getBuiltinTools', () => {
  it('should return 8 pure builtin tools (zero dependency)', () => {
    const tools = getBuiltinTools();
    const names = tools.map((t) => t.definition.name);

    expect(names).toContain('shell');
    expect(names).toContain('file_read');
    expect(names).toContain('file_write');
    expect(names).toContain('file_list');
    expect(names).toContain('file_edit');
    expect(names).toContain('file_search');
    expect(names).toContain('http_request');
    expect(names).toContain('env_info');
    expect(tools.length).toBe(8);
  });

  it('registers shell last so models prefer dedicated tools', () => {
    const tools = getBuiltinTools();
    const names = tools.map((t) => t.definition.name);
    expect(names[names.length - 1]).toBe('shell');
    const shell = tools.find((t) => t.definition.name === 'shell')!;
    expect(shell.definition.description).toMatch(/LAST RESORT/i);
  });
});

// ── file_list caps ──

describe('file_list entry caps and skip dirs', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `octopi-fs-${randomUUID()}`);
    await mkdir(join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(tmpDir, '.git'), { recursive: true });
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'x');
    await writeFile(join(tmpDir, '.git', 'HEAD'), 'ref');
    await writeFile(join(tmpDir, 'src', 'a.ts'), 'export {};');
    await writeFile(join(tmpDir, 'README.md'), '# t');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('recursive skips node_modules/.git and caps entries', async () => {
    const { createFileListTool } = await import(
      '../../src/harness/plugin-ecosystem/tools/builtin.js'
    );
    const tool = createFileListTool();
    const result = (await tool.handler(
      { path: tmpDir, recursive: true },
      makeContext({ cwd: tmpDir }),
    )) as { entries: Array<{ path: string }>; count: number; truncated?: boolean };

    const paths = result.entries.map((e) => e.path);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.git'))).toBe(false);
    expect(paths.some((p) => p.includes('src'))).toBe(true);
  });

  it('caps entries at maxEntries', async () => {
    const { createFileListTool } = await import(
      '../../src/harness/plugin-ecosystem/tools/builtin.js'
    );
    for (let i = 0; i < 5; i++) {
      await writeFile(join(tmpDir, 'src', `f${i}.ts`), 'x');
    }
    const tool = createFileListTool();
    const result = (await tool.handler(
      { path: join(tmpDir, 'src'), maxEntries: 2 },
      makeContext({ cwd: tmpDir }),
    )) as { count: number; totalCount: number; truncated?: boolean; truncatedReason?: string };

    expect(result.count).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe('max_entries');
    expect(result.totalCount).toBeGreaterThan(2);
  });

  it('stops recursion at maxDepth and reports depthCapped', async () => {
    const { createFileListTool } = await import(
      '../../src/harness/plugin-ecosystem/tools/builtin.js'
    );
    // depth 1=src, 2=a, 3=b, 4=c, 5=d（默认 maxDepth=4 时不应出现 d）
    await mkdir(join(tmpDir, 'src', 'a', 'b', 'c', 'd'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'a', 'b', 'c', 'd', 'deep.ts'), 'x');
    await writeFile(join(tmpDir, 'src', 'a', 'shallow.ts'), 'x');

    const tool = createFileListTool();
    const result = (await tool.handler(
      { path: tmpDir, recursive: true, maxDepth: 3 },
      makeContext({ cwd: tmpDir }),
    )) as {
      entries: Array<{ path: string }>;
      maxDepth: number;
      depthCapped?: boolean;
      truncated?: boolean;
      truncatedReason?: string;
    };

    const paths = result.entries.map((e) => e.path);
    expect(result.maxDepth).toBe(3);
    expect(result.depthCapped).toBe(true);
    expect(result.truncatedReason).toBe('max_depth');
    expect(paths.some((p) => p.includes('shallow.ts'))).toBe(true);
    expect(paths.some((p) => p.includes('deep.ts'))).toBe(false);
    // 仅目录 b 在 maxDepth=3 时被列出；c/d 在更深一层，不会出现
    expect(paths.some((p) => p.endsWith('a'))).toBe(true);
  });

  it('clamps maxDepth to hard cap 8', async () => {
    const { createFileListTool } = await import(
      '../../src/harness/plugin-ecosystem/tools/builtin.js'
    );
    const tool = createFileListTool();
    const result = (await tool.handler(
      { path: tmpDir, recursive: true, maxDepth: 99 },
      makeContext({ cwd: tmpDir }),
    )) as { maxDepth: number };

    expect(result.maxDepth).toBe(8);
  });

  it('accepts glob pattern *.md without regex crash', async () => {
    const { createFileListTool } = await import(
      '../../src/harness/plugin-ecosystem/tools/builtin.js'
    );
    const tool = createFileListTool();
    const result = (await tool.handler(
      { path: tmpDir, pattern: '*.md' },
      makeContext({ cwd: tmpDir }),
    )) as { entries: Array<{ name: string }> };

    expect(result.entries.some((e) => e.name === 'README.md')).toBe(true);
    expect(result.entries.every((e) => e.name.endsWith('.md'))).toBe(true);
  });

  it('still accepts regex patterns', async () => {
    const { createFileListTool } = await import(
      '../../src/harness/plugin-ecosystem/tools/builtin.js'
    );
    const tool = createFileListTool();
    const result = (await tool.handler(
      { path: join(tmpDir, 'src'), pattern: '\\.ts$' },
      makeContext({ cwd: tmpDir }),
    )) as { entries: Array<{ name: string }> };

    expect(result.entries.some((e) => e.name === 'a.ts')).toBe(true);
  });

  it('recursive + pattern still descends into non-matching dirs', async () => {
    const { createFileListTool } = await import(
      '../../src/harness/plugin-ecosystem/tools/builtin.js'
    );
    await mkdir(join(tmpDir, 'src', 'docs'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'docs', 'guide.md'), '#');

    const tool = createFileListTool();
    const result = (await tool.handler(
      { path: tmpDir, recursive: true, pattern: '*.md' },
      makeContext({ cwd: tmpDir }),
    )) as { entries: Array<{ name: string; path: string }> };

    expect(result.entries.some((e) => e.name === 'guide.md')).toBe(true);
    expect(result.entries.some((e) => e.name === 'README.md')).toBe(true);
  });

  it('glob is anchored: *.md does not match file.md.bak', async () => {
    const { createFileListTool } = await import(
      '../../src/harness/plugin-ecosystem/tools/builtin.js'
    );
    await writeFile(join(tmpDir, 'src', 'file.md.bak'), 'x');

    const tool = createFileListTool();
    const result = (await tool.handler(
      { path: join(tmpDir, 'src'), pattern: '*.md' },
      makeContext({ cwd: tmpDir }),
    )) as { entries: Array<{ name: string }> };

    expect(result.entries.some((e) => e.name === 'file.md.bak')).toBe(false);
    expect(result.entries.every((e) => e.name.endsWith('.md'))).toBe(true);
  });
});
