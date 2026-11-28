/**
 * file_read numbered 输出：行首绝对行号（引用口径）。
 * 契约：numbered=true 时行首 `${line}: `；offset 分页行号连续；截断头保留后行号仍对齐；
 * 非法值 fail-loud（打错字的调用不能以为拿到了行号）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { createFileReadTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/builtin.js';
import type { ToolExecutionContext } from '@octopi-agent/core/types/tools.js';

function makeContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    sessionId: 'test-session',
    agentId: 'test-agent',
    messages: [],
    ...overrides,
  } as ToolExecutionContext;
}

describe('file_read numbered output', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `octopi-numbered-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    filePath = join(tmpDir, 'sample.txt');
    await writeFile(filePath, ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].join('\n'), 'utf8');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('numbered=true 时行首带绝对行号', async () => {
    const out = (await createFileReadTool().handler(
      { path: filePath, numbered: true },
      makeContext({ cwd: tmpDir }),
    )) as { content: string; fromLine: number; toLine: number };
    expect(out.content).toBe('1: alpha\n2: beta\n3: gamma\n4: delta\n5: epsilon');
    expect(out.fromLine).toBe(1);
    expect(out.toLine).toBe(5);
  });

  it('offset 分页后行号保持文件绝对行号', async () => {
    const out = (await createFileReadTool().handler(
      { path: filePath, numbered: true, offset: 3, limit: 2 },
      makeContext({ cwd: tmpDir }),
    )) as { content: string; fromLine: number; toLine: number };
    expect(out.content).toBe('3: gamma\n4: delta');
    expect(out.fromLine).toBe(3);
    expect(out.toLine).toBe(4);
  });

  it('缺省 / numbered=false 保持原文不带行号', async () => {
    const raw = (await createFileReadTool().handler(
      { path: filePath },
      makeContext({ cwd: tmpDir }),
    )) as { content: string };
    expect(raw.content).toBe('alpha\nbeta\ngamma\ndelta\nepsilon');
    const off = (await createFileReadTool().handler(
      { path: filePath, numbered: false },
      makeContext({ cwd: tmpDir }),
    )) as { content: string };
    expect(off.content).toBe('alpha\nbeta\ngamma\ndelta\nepsilon');
  });

  it('非布尔 numbered 值 fail-loud，不静默丢行号', async () => {
    await expect(
      createFileReadTool().handler(
        { path: filePath, numbered: 'true' },
        makeContext({ cwd: tmpDir }),
      ),
    ).rejects.toThrow(/numbered/);
  });

  it('回执字段：请求 numbered 带 numbered=true，未请求时不出现', async () => {
    const out = (await createFileReadTool().handler(
      { path: filePath, numbered: true },
      makeContext({ cwd: tmpDir }),
    )) as Record<string, unknown>;
    expect(out.numbered).toBe(true);
    const raw = (await createFileReadTool().handler(
      { path: filePath },
      makeContext({ cwd: tmpDir }),
    )) as Record<string, unknown>;
    expect('numbered' in raw).toBe(false);
  });

  it('offset/limit 非法值 fail-loud（与 view/numbered 同族，防小数行号锚点）', async () => {
    await expect(
      createFileReadTool().handler({ path: filePath, offset: 2.5 }, makeContext({ cwd: tmpDir })),
    ).rejects.toThrow(/offset/);
    await expect(
      createFileReadTool().handler({ path: filePath, limit: 0 }, makeContext({ cwd: tmpDir })),
    ).rejects.toThrow(/limit/);
    await expect(
      createFileReadTool().handler({ path: filePath, offset: '3' }, makeContext({ cwd: tmpDir })),
    ).rejects.toThrow(/offset/);
  });

  it('L1 截断头保留后行号仍与内容对齐', async () => {
    const big = join(tmpDir, 'big.txt');
    await writeFile(
      big,
      Array.from({ length: 5000 }, (_, i) => `line-${i + 1}-pad-padding`).join('\n'),
      'utf8',
    );
    const out = (await createFileReadTool().handler(
      { path: big, numbered: true },
      makeContext({ cwd: tmpDir }),
    )) as { content: string; truncated: boolean };
    expect(out.truncated).toBe(true);
    expect(out.content.startsWith('1: line-1-')).toBe(true);
    expect(out.content.split('\n')[1]).toMatch(/^2: line-2-/);
  });
});
