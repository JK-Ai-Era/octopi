/**
 * TUI @path 文件引用内联——展开纯逻辑。
 *
 * 钉住：内联格式（附件标注+围栏+语言标注）、引号路径、尾部标点剥离、
 * 读不到/二进制/超预算保持原文并记账、单文件截断标注、总预算。
 */

import { describe, it, expect } from 'vitest';
import { expandFileReferences } from '../src/integration/tui/attach.js';

function fakeFs(files: Record<string, string>) {
  return {
    readFileText: (path: string): string | null => files[path] ?? null,
  };
}

describe('expandFileReferences', () => {
  it('把 @path 展开为附件标注 + 围栏文本（含语言标注）', () => {
    const result = expandFileReferences(
      '看下 @src/app.ts 的实现',
      fakeFs({ 'src/app.ts': 'export const x = 1;' }),
    );
    expect(result.expanded).toEqual([{ path: 'src/app.ts', chars: 19, truncated: false }]);
    expect(result.failed).toEqual([]);
    expect(result.text).toContain('看下 [附件 src/app.ts]');
    expect(result.text).toContain('```ts');
    expect(result.text).toContain('export const x = 1;');
  });

  it('引号路径（含空格）与尾部标点剥离', () => {
    const result = expandFileReferences(
      '读 @"docs/my notes.md"，然后继续',
      fakeFs({ 'docs/my notes.md': '# note' }),
    );
    expect(result.expanded[0].path).toBe('docs/my notes.md');
    expect(result.text).toContain('，然后继续');

    const result2 = expandFileReferences('看 @a.txt。', fakeFs({ 'a.txt': 'A' }));
    expect(result2.expanded[0].path).toBe('a.txt');
    expect(result2.text).toContain('。');
  });

  it('读不到/二进制保持原文并记账（消息照发）', () => {
    const result = expandFileReferences(
      '引用 @nope.txt 和 @pic.bin',
      fakeFs({ 'pic.bin': 'ab\u0000cd' }),
    );
    expect(result.text).toContain('@nope.txt');
    expect(result.text).toContain('@pic.bin');
    expect(result.failed).toEqual([
      { path: 'nope.txt', reason: 'not_found' },
      { path: 'pic.bin', reason: 'binary' },
    ]);
    expect(result.expanded).toEqual([]);
  });

  it('单文件超限截断并标注（不算失败）', () => {
    const big = 'a'.repeat(100);
    const result = expandFileReferences('@big.txt', fakeFs({ 'big.txt': big }), {
      maxCharsPerFile: 10,
      maxTotalChars: 1000,
    });
    expect(result.expanded).toEqual([{ path: 'big.txt', chars: 10, truncated: true }]);
    expect(result.failed).toEqual([]);
    expect(result.text).toContain('截断：原 100 字符');
    expect(result.text).not.toContain('a'.repeat(11));
  });

  it('总预算耗尽后剩余引用保持原文（over_budget）', () => {
    const files = { 'a.txt': '12345', 'b.txt': '67890' };
    const result = expandFileReferences('@a.txt @b.txt', fakeFs(files), {
      maxCharsPerFile: 100,
      maxTotalChars: 5,
    });
    expect(result.expanded.map((e) => e.path)).toEqual(['a.txt']);
    expect(result.failed).toEqual([{ path: 'b.txt', reason: 'over_budget' }]);
    expect(result.text).toContain('@b.txt');
  });

  it('无引用时原文原样返回', () => {
    const text = '普通消息，没有附件引用';
    const result = expandFileReferences(text, fakeFs({}));
    expect(result.text).toBe(text);
    expect(result.expanded).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});
