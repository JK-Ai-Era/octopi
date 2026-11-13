/**
 * 摘要输出闸门：回声判据与可观测性（2026-11-13）
 *
 * 事故形态：一次摘要被判污染 → strict 重试 → 整包 348k token 重发（+59s），
 * 但全程零事件，UI 只显示「已等待 Ns」，日志无迹可查。
 *
 * 根因两条：
 * 1. `verbatim_echo` 的「命中 ≥3 行」分支与四段式模板的「④ Evidence pointers」要求
 *    结构性冲突——模板要求写文件路径/commit id/测试名，三条合法证据即触发重发。
 * 2. 回声比对源用 `String(m.content)`，对 content block 数组返回 "[object Object]"，
 *    真实请求 1059 条中 1037 条（97.9%）正文对闸门完全不可见（假阴性）。
 */
import { describe, it, expect } from 'vitest';
import { evaluateEcho, inspectSummaryOutput } from '@octopi-agent/engine/harness';

/** 三条按模板要求写出的合法证据行（均 ≥40 字符，且逐字出现在输入里） */
const EVIDENCE_LINES = [
  '- `v0.113.26`（`7af0a9b1`）装配出口收口，工作树干净，全部 tag 已打',
  'packages/engine/src/harness/context/capabilities/compact/engine.ts',
  'tests/harness/assemble-exit-parity.test.ts（4 例，注入漂移验证）',
];

/** 构造一份合法交接书：正文是新的散文，证据行按模板要求引用 */
function legitimateHandoff(): string {
  const prose = '本轮工作把装配出口收敛为单一实现，避免了同一逻辑的多处实现。'.repeat(120);
  return [
    '# 交接摘要',
    '## 1. Goal 与状态',
    prose,
    '## 4. Evidence pointers',
    ...EVIDENCE_LINES,
  ].join('\n');
}

describe('verbatim_echo：按长度占比判复读，不按行数', () => {
  it('引用 3 条合法证据（占比极低）不得判污染', () => {
    const handoff = legitimateHandoff();
    const verdict = evaluateEcho(handoff, EVIDENCE_LINES.join('\n'));
    // 旧规则 hits>=3 会直接判污染；这正是 2026-11-13 误判的形状
    expect(verdict.hits).toBe(3);
    expect(verdict.contaminated).toBe(false);
    expect(verdict.hitChars).toBeLessThan(verdict.textChars * 0.6);
  });

  it('引用 10 条证据仍不得判污染（只要占比低）', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `packages/engine/src/harness/context/file-${i}.ts`);
    const handoff = legitimateHandoff() + '\n' + lines.join('\n');
    const verdict = evaluateEcho(handoff, lines.join('\n'));
    expect(verdict.hits).toBe(10);
    expect(verdict.contaminated).toBe(false);
  });

  it('真正的逐字复读（输出基本等于输入）必须判污染', () => {
    // 失效模式（2026-10-28 实测）：模型把对话样本当语料续写
    // 每行必须 ≥40 字符（中文按字符计：闸门的回声单元是「长行」，短行重复本就不算复读）
    const input = Array.from({ length: 20 }, (_, i) =>
      `第 ${i} 条：装配出口把重复表达式收敛为单一实现，避免多处手抄漂移——本轮已收口并验证。`,
    ).join('\n');
    const replay = input; // 输出 = 输入原文
    const verdict = evaluateEcho(replay, input);
    expect(verdict.contaminated).toBe(true);
    expect(verdict.hitChars / verdict.textChars).toBeGreaterThanOrEqual(0.6);
  });

  it('重复行只计一次（输入里同一行出现多次不得放大命中量）', () => {
    const line = 'packages/engine/src/harness/context/default-context-engine.ts';
    const source = Array.from({ length: 20 }, () => line).join('\n');
    const verdict = evaluateEcho(`证据：${line}\n新写的散文正文。`, source);
    expect(verdict.hits).toBe(1);
    expect(verdict.hitChars).toBe(line.length);
  });

  it('短于 40 字符的片段不计入命中（标题/表头重复不算复读）', () => {
    const verdict = evaluateEcho('## 1. Goal\n## 2. Open items', '## 1. Goal\n## 2. Open items');
    expect(verdict.hits).toBe(0);
    expect(verdict.contaminated).toBe(false);
  });
});

describe('inspectSummaryOutput：三条规则与明细', () => {
  it('干净输出返回 reason=null 且仍给出回声明细（供可观测上报）', () => {
    const handoff = legitimateHandoff();
    const result = inspectSummaryOutput(handoff, EVIDENCE_LINES.join('\n'));
    expect(result.reason).toBeNull();
    expect(result.echo).toBeDefined();
    expect(result.echo!.hits).toBe(3);
  });

  it('对话体续写判 transcript_shape', () => {
    const result = inspectSummaryOutput('正文\n[ASSISTANT]\n再来一次调用工具', '输入');
    expect(result.reason).toBe('transcript_shape');
  });

  it('罐头拒答判 canned_refusal', () => {
    const result = inspectSummaryOutput('The request was rejected because it was considered high risk.');
    expect(result.reason).toBe('canned_refusal');
  });
});
