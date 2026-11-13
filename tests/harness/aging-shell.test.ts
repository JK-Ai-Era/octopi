/**
 * shell 结果老化：保留「成功与否 + 输出长什么样」，丢掉重复元数据
 *
 * 依据（2026-11-13 实测 35 条未老化 shell 结果）：
 * - `isolation` 315 字符/条，同一会话内只有一种取值；
 * - `shell` 43 字符/条，`{kind, executable}` 全程不变；
 * - `durationMs` 对历史回看无意义。
 * 三者合计占 shell 结果的 36%。
 */

import { describe, it, expect } from 'vitest';
import { createShellTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/builtin.js';

const age = (result: unknown): string | undefined =>
  createShellTool().ageResult!({ args: { command: 'x' }, result, chars: JSON.stringify(result ?? null).length });

const big = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `line ${i + 1} of output`).join('\n');

describe('shell 结果老化：丢弃重复元数据', () => {
  it('输出里不再出现 isolation / shell / durationMs', () => {
    const out = age({
      stdout: big(200),
      stderr: '',
      exitCode: 0,
      durationMs: 1234,
      truncated: false,
      rawStdoutLength: 4000,
      terminated: false,
      isolation: { backend: 'supervised-spawn', network: 'open', privilege: 'same', notes: ['x', 'y'] },
      shell: { kind: 'bash', executable: '/bin/bash' },
    });
    expect(out).toBeDefined();
    expect(out).not.toContain('isolation');
    expect(out).not.toContain('supervised-spawn');
    expect(out).not.toContain('durationMs');
    expect(out).not.toContain('/bin/bash');
  });

  it('保留退出码与首尾行（尾部多留——错误与汇总通常在末尾）', () => {
    const out = age({ stdout: big(50), stderr: '', exitCode: 3, rawStdoutLength: 855, terminated: false })!;
    expect(out).toContain('exit 3');
    expect(out).toContain('head: line 1 of output');
    expect(out).toContain('line 50 of output'); // 尾部最后一行
    expect(out).not.toContain('line 25 of output'); // 中段被丢
  });

  it('短输出保留完整正文（仍去元数据，只是不截行）', () => {
    const out = age({
      stdout: 'a\nb\nc\nd\ne\nf\ng\nh',
      stderr: '',
      exitCode: 0,
      rawStdoutLength: 15,
      terminated: false,
      isolation: { backend: 'supervised-spawn' },
    })!;
    // 8 行全在（超过 head 3 + tail 5 的边界，若走截断会丢中段）
    for (const l of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) expect(out).toContain(l);
    expect(out).not.toContain('supervised-spawn');
  });
});

describe('shell 结果老化：保留「输出可能不完整」的信号', () => {
  it('terminated 时明确标注，且带终止原因', () => {
    const out = age({
      stdout: big(5),
      stderr: '',
      exitCode: undefined,
      rawStdoutLength: 90,
      terminated: true,
      terminateReason: 'Output size limit exceeded',
    })!;
    expect(out).toContain('terminated');
    expect(out).toContain('Output size limit exceeded');
    expect(out).toContain('exit code unknown');
  });

  it('被闸门截断时给出「原始长度 vs 展示长度」', () => {
    const out = age({
      stdout: big(10),
      stderr: '',
      exitCode: 0,
      rawStdoutLength: 45_231,
      truncated: true,
      terminated: false,
    })!;
    expect(out).toContain('output 45231 chars');
  });

  it('stderr 非空时保留开头（失败原因通常在此）', () => {
    const out = age({
      stdout: big(80),
      stderr: 'fatal: not a git repository (or any parent)',
      exitCode: 128,
      rawStdoutLength: 1200,
      terminated: false,
    })!;
    expect(out).toContain('stderr:');
    expect(out).toContain('fatal: not a git repository');
  });
});

describe('shell 结果老化：不膨胀', () => {
  it('永不返回比原结果更长的文本（否则守卫会跳过，等于没老化的白算）', () => {
    const result = {
      stdout: big(3),
      stderr: '',
      exitCode: 0,
      rawStdoutLength: 50,
      terminated: false,
      isolation: { backend: 'supervised-spawn', network: 'open', privilege: 'same' },
      shell: { kind: 'bash', executable: '/bin/bash' },
    };
    const out = age(result)!;
    expect(out.length).toBeLessThan(JSON.stringify(result).length);
  });

  it('单行超长时按行截断，不把指针撑成正文', () => {
    const out = age({
      stdout: 'x'.repeat(2000),
      stderr: '',
      exitCode: 0,
      rawStdoutLength: 2000,
      terminated: false,
    })!;
    expect(out.length).toBeLessThan(500);
  });
});
