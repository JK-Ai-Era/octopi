/**
 * F1-B1：file_search L1 输出硬顶（结构化收缩，零 LLM）
 *
 * 红线（arch/long-session-latency.md §5 B1）：
 * - 定位符（file+line）永远全保，零损失
 * - 收缩只动预览体，顺序固定：剥 context 行 → content 行截断 → 预览只留前 K 条
 * - registry 缺省 mode='never'：L2 永不改写搜索结果
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createFileSearchTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/file-search.js';
import { createDefaultToolBindings } from '@octopi-agent/engine/harness/context/capabilities/summary/registry.js';
import { resolveSummaryToolBindings } from '../../src/cli/daemon.js';
import type { ToolExecutionContext, ToolFileEffects } from '@octopi-agent/core/types/tools.js';

function testFileEffects(): ToolFileEffects {
  return {
    async writeFile(path, data) {
      await writeFile(path, data);
    },
    async appendFile(path, data) {
      await writeFile(path, data, { flag: 'a' });
    },
  };
}

function testMemoryEffects(): import('@octopi-agent/core/types/tools.js').MemoryEffectJournal {
  return {
    async recordInsert() {},
    async recordUpdate() {},
    async recordDelete() {},
  };
}

function makeContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    sessionId: 'test-session',
    agentId: 'test-agent',
    messages: [],
    fileEffects: testFileEffects(),
    memoryEffects: testMemoryEffects(),
    ...overrides,
  };
}

describe('file_search L1 output cap', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'octopi-fs-l1-'));
    await mkdir(join(tmpDir, 'sub'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should cap a 50k-char match line at the content preview while keeping locators', async () => {
    await writeFile(join(tmpDir, 'big.txt'), `hitme ${'x'.repeat(50_000)}\n`);

    const tool = createFileSearchTool();
    const result = (await tool.handler(
      { pattern: 'hitme', path: tmpDir },
      makeContext({ cwd: tmpDir }),
    )) as any;

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].file).toBe('big.txt');
    expect(result.matches[0].line).toBe(1);
    expect(result.matches[0].content.startsWith('hitme ')).toBe(true);
    expect(result.matches[0].content).toContain('…[truncated]');
    expect(result.matches[0].content.length).toBeLessThan(240);
    expect(result.outputCap.applied).toBe(true);
    expect(result.outputCap.stages).toEqual(['content_lines']);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe('l1_cap');
    expect(result.hints.some((h: string) => h.includes('L1 output cap'))).toBe(true);
  });

  it('should drop context lines before truncating content', async () => {
    const pad = 'p'.repeat(120);
    let text = '';
    for (let i = 0; i < 15; i++) {
      text += `${pad}\n${pad}\n${pad}\nMATCH ${i} ${pad}\n${pad}\n${pad}\n${pad}\n`;
    }
    await writeFile(join(tmpDir, 'ctx.txt'), text);

    const tool = createFileSearchTool();
    const result = (await tool.handler(
      { pattern: 'MATCH', path: tmpDir, context_lines: 3 },
      makeContext({ cwd: tmpDir }),
    )) as any;

    expect(result.matches).toHaveLength(15);
    expect(result.outputCap.stages).toEqual(['context_lines']);
    expect(result.outputCap.previewKept).toBe(15);
    for (const m of result.matches) {
      expect(m.before).toBeUndefined();
      expect(m.after).toBeUndefined();
      expect(m.content).not.toContain('…[truncated]');
    }
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe('l1_cap');
  });

  it('should keep every file+line locator while capping previews under a small budget', async () => {
    let text = '';
    for (let i = 0; i < 60; i++) text += `hitme row ${String(i).padStart(2, '0')} ${'y'.repeat(140)}\n`;
    await writeFile(join(tmpDir, 'many.txt'), text);

    const tool = createFileSearchTool({
      summary: { toolBindings: { file_search: { maxReturnChars: 4000 } } },
    });
    const result = (await tool.handler(
      { pattern: 'hitme', path: tmpDir, max_results: 200 },
      makeContext({ cwd: tmpDir }),
    )) as any;

    expect(result.matches).toHaveLength(60);
    expect(result.outputCap.stages).toContain('preview_cap');
    expect(result.outputCap.previewKept).toBeLessThan(60);
    expect(result.matches[0].content).not.toBe('…[preview omitted]');
    expect(result.matches[59].content).toBe('…[preview omitted]');
    // 定位符零损失：每条保留唯一 file+line
    const locators = result.matches.map((m: any) => `${m.file}:${m.line}`);
    expect(new Set(locators).size).toBe(60);
    expect(JSON.stringify(result.matches).length).toBeLessThanOrEqual(4000);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe('l1_cap');
  });

  it('should preserve all locators even when they alone exceed the budget', async () => {
    let text = '';
    for (let i = 0; i < 60; i++) text += `hitme row ${String(i).padStart(2, '0')} ${'y'.repeat(140)}\n`;
    await writeFile(join(tmpDir, 'many.txt'), text);

    const tool = createFileSearchTool({
      summary: { toolBindings: { file_search: { maxReturnChars: 1000 } } },
    });
    const result = (await tool.handler(
      { pattern: 'hitme', path: tmpDir, max_results: 200 },
      makeContext({ cwd: tmpDir }),
    )) as any;

    // 预算装不下 60 条定位符：清单仍全保（定位符零损失优先于预算）
    expect(result.matches).toHaveLength(60);
    expect(result.outputCap.previewKept).toBe(0);
    for (const m of result.matches) {
      expect(m.file).toBe('many.txt');
      expect(typeof m.line).toBe('number');
      expect(m.content).toBe('…[preview omitted]');
    }
  });

  it('should leave small results untouched', async () => {
    await writeFile(join(tmpDir, 'a.txt'), 'hello hitme\n');

    const tool = createFileSearchTool();
    const result = (await tool.handler(
      { pattern: 'hitme', path: tmpDir },
      makeContext({ cwd: tmpDir }),
    )) as any;

    expect(result.outputCap).toBeUndefined();
    expect(result.truncated).toBe(false);
    expect(result.truncatedReason).toBeUndefined();
    expect(result.matches[0].content).toBe('hello hitme');
  });

  it('should mark count truncation distinctly and combine with l1_cap', async () => {
    await writeFile(join(tmpDir, 'small.txt'), 'hitme one\nhitme two\nhitme three\n');

    const tool = createFileSearchTool();
    const countOnly = (await tool.handler(
      { pattern: 'hitme', path: tmpDir, max_results: 1 },
      makeContext({ cwd: tmpDir }),
    )) as any;
    expect(countOnly.truncated).toBe(true);
    expect(countOnly.truncatedReason).toBe('max_results');
    expect(countOnly.outputCap).toBeUndefined();

    await writeFile(join(tmpDir, 'big.txt'), `hitme ${'x'.repeat(50_000)}\nhitme ${'y'.repeat(50_000)}\n`);
    const combined = (await tool.handler(
      { pattern: 'hitme', path: tmpDir, glob: 'big.txt', max_results: 1 },
      makeContext({ cwd: tmpDir }),
    )) as any;
    expect(combined.truncatedReason).toBe('max_results+l1_cap');
    expect(combined.outputCap.applied).toBe(true);
  });

  it('should keep the registry default binding L1-only (mode never)', () => {
    const binding = createDefaultToolBindings()['file_search'];
    expect(binding.mode).toBe('never');
    expect(binding.maxReturnChars).toBe(8000);
    expect(binding.informationalKinds).toEqual([]);
  });

  it('should honor summary.tools.file_search.maxReturnChars through the daemon config wiring', async () => {
    let text = '';
    for (let i = 0; i < 60; i++) text += `hitme row ${String(i).padStart(2, '0')} ${'y'.repeat(140)}\n`;
    await writeFile(join(tmpDir, 'many.txt'), text);

    // 与 daemon 接线同路径：config.summary.tools → resolveSummaryToolBindings → support.toolBindings
    const toolBindings = resolveSummaryToolBindings({
      maxReturnChars: 5000,
      file_search: { maxReturnChars: 1200 },
      shell: { maxReturnChars: 4000 },
    });
    expect(toolBindings.file_search?.maxReturnChars).toBe(1200);
    expect(toolBindings.shell?.maxReturnChars).toBe(4000);
    expect(toolBindings.maxReturnChars).toBeUndefined();

    const tool = createFileSearchTool({ summary: { toolBindings } });
    const result = (await tool.handler(
      { pattern: 'hitme', path: tmpDir, max_results: 200 },
      makeContext({ cwd: tmpDir }),
    )) as any;

    expect(result.outputCap.budgetChars).toBe(1200);
    expect(result.matches).toHaveLength(60);
    // 1200 装不下 60 条定位符：预览全占位、清单仍全保
    expect(result.outputCap.previewKept).toBe(0);
    expect(result.matches.every((m: any) => typeof m.line === 'number')).toBe(true);
  });
});
