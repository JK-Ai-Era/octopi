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
    expect(files).toContain(join('sub', 'c.ts'));
  });

  it('should filter by glob pattern', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'foo', path: tmpDir, glob: '*.ts' },
      makeContext({ cwd: tmpDir }),
    ) as any;

    const files = result.matches.map((m: any) => m.file);
    expect(files.every((f: string) => f.endsWith('.ts'))).toBe(true);
  });

  it('should support regex search', async () => {
    const tool = createFileSearchTool();
    const result = await tool.handler(
      { pattern: 'const \\w+ =', path: tmpDir, regex: true },
      makeContext({ cwd: tmpDir }),
    ) as any;

    expect(result.matches.length).toBe(2);
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
});
