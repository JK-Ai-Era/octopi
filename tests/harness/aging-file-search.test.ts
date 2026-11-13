/**
 * file_search 结果老化（定位符清单）
 *
 * 背景（default-web-1794346953041 实测）：277 次调用占上下文 21.4%（681,273 字符），
 * 且没有 per-tool 策略——按默认机械指针（282 字符/条）处理，而它本可以更省：
 *
 * - `before`/`after` 上下文行占 matches 的 58.6%（搜索时刻的文件摘录，行号即路径）
 * - `content` 是已截断的匹配行（工具自己的 L1 已声明「file+line 清单全保，body 是预览」）
 * - `matchedFiles` 可由 matches 聚合推出（230/277 完全一致，其余只差排序）
 * - `diagnostics` 中 45% 是入参回显，`patterns` 与 `compiledPatterns` 在 240/277 重复
 *
 * 实测收益：650,546 → 39,286（省 94.0%），均值 2349 → 142（默认指针为 282）。
 */
import { describe, expect, it } from 'vitest';
import { createFileSearchTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/file-search.js';

const ager = createFileSearchTool().ageResult!;

function age(result: unknown) {
  return ager({ args: {}, result, chars: JSON.stringify(result).length });
}

/** 构造与真实工具输出同形的结果 */
function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    matches: [
      { file: 'a/b/c.ts', line: 12, content: 'const x = 1;', before: ['// header'], after: ['// tail'] },
      { file: 'a/b/c.ts', line: 40, content: 'const y = 2;' },
      { file: 'd/e.ts', line: 7, content: 'export const z = 3;' },
    ],
    totalMatches: 3,
    matchedFiles: [
      { file: 'a/b/c.ts', matches: 2 },
      { file: 'd/e.ts', matches: 1 },
    ],
    truncated: false,
    searchedFiles: 3,
    diagnostics: {
      root: '/repo',
      patternMode: 'literal',
      patterns: ['const'],
      compiledPatterns: ['const'],
      filesSeen: 4,
      filesMatchedByGlob: 4,
      filesSearched: 4,
      filesSkipped: 0,
      filesSkippedOversize: 0,
      filesSkippedBinary: 0,
      maxFileBytes: 50000000,
    },
    hints: [],
    ...overrides,
  };
}

describe('file_search 结果老化', () => {
  it('按文件聚合行号：file 只出现一次', () => {
    const out = age(makeResult())!;
    expect(out.startsWith('[aged] file_search'), '必须带老化前缀，否则被当成原文').toBe(true);
    // a/b/c.ts 出现一次，其两行号并列
    expect(out.split('a/b/c.ts').length - 1, 'file 路径必须只出现一次').toBe(1);
    expect(out).toContain('a/b/c.ts: 12, 40');
    expect(out).toContain('d/e.ts: 7');
    expect(out).toContain('in 2 file(s)');
  });

  it('丢弃上下文行、content 与 diagnostics 入参回显', () => {
    const out = age(makeResult())!;
    for (const noise of ['// header', '// tail', 'const x = 1;', '/repo', 'compiledPatterns', 'maxFileBytes', '50000000']) {
      expect(out, `不得包含 ${noise}`).not.toContain(noise);
    }
  });

  it('截断时如实标注下界（不谎称全量）', () => {
    const out = age(makeResult({ truncated: true, truncatedReason: 'max_results' }))!;
    expect(out, 'max_results 截断时真实命中更多，必须标注').toContain('>=3 (truncated)');
    // 未截断时不得出现下界符号
    expect(age(makeResult())!).not.toContain('>=');
  });

  it('零命中仍返回可辨识指针（不发 undefined，保留原文会白占空间）', () => {
    const out = age(makeResult({ matches: [], totalMatches: 0, matchedFiles: [] }))!;
    expect(out).toContain('0 hits in 0 file(s)');
    expect(out, '提示没有保留定位符，便于模型知道结果为空').toContain('no locators retained');
  });

  it('纯函数：同输入逐字节相同（老化计划每次装配都重算）', () => {
    const r = makeResult();
    expect(age(r)).toBe(age(r));
    // args 不参与：两份内容相同的结果（不同入参来源）必须产生同一指针
    expect(age(r)).toBe(age(makeResult()));
  });

  it('聚合顺序按首次出现，不做排序（避免不确定性）', () => {
    const out = age(
      makeResult({
        matches: [
          { file: 'z.ts', line: 1, content: '' },
          { file: 'a.ts', line: 2, content: '' },
        ],
        matchedFiles: [],
      }),
    )!;
    expect(out.indexOf('z.ts'), '保持首次出现顺序').toBeLessThan(out.indexOf('a.ts'));
  });

  it('结构不符时返回 undefined（保留原文，不伪造指针）', () => {
    expect(age(null)).toBeUndefined();
    expect(age({})).toBeUndefined();
    expect(age({ matches: 'not-an-array' })).toBeUndefined();
  });

  it('不膨胀：真实形态的大结果必须显著变短', () => {
    const big = {
      ...makeResult(),
      matches: Array.from({ length: 200 }, (_, i) => ({
        file: `src/module-${String(i % 20)}.ts`,
        line: i + 1,
        content: 'x'.repeat(120),
        before: ['y'.repeat(100)],
        after: ['z'.repeat(100)],
      })),
      totalMatches: 200,
    };
    const out = age(big)!;
    const raw = JSON.stringify(big).length;
    expect(out.length, `指针 ${out.length} 必须远小于原文 ${raw}`).toBeLessThan(raw);
    // 20 个文件 × 10 行，路径只出现 20 次
    expect(out.split('src/module-').length - 1).toBe(20);
  });
});
