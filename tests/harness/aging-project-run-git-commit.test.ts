/**
 * project_run / git_commit 结果老化
 *
 * 背景（default-web-1794346953041 实测）：
 * - `project_run` 43 次 278,106 字符：stdout 64%（含 13,980 字符 ANSI 噪声）、stderr 29%
 *   （其中 34 条 exit=0 的 37,002 字符全是 `[AgentBuilder]` 一类**用例自身日志**，92% 非错误行）、
 *   isolation 5%（43/43 完全相同）。
 * - `git_commit` 26 次 55,501 字符：message 占 69%，且 **25/26 与入参逐字相同**；
 *   isolation 8,190 字符（26/26 相同）；stdout 已含 sha + subject + 文件统计。
 */
import { describe, expect, it } from 'vitest';
import { createProjectRunTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/package-tools.js';
import { createGitCommitTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/git-tools.js';

const runAger = createProjectRunTool().ageResult!;
const commitAger = createGitCommitTool().ageResult!;

const ISO = { backend: 'supervised-spawn', notes: ['sandbox-exec=/usr/bin/sandbox-exec'] };

function ageRun(result: unknown, args: Record<string, unknown> = {}) {
  return runAger({ args, result, chars: JSON.stringify(result).length });
}
function ageCommit(result: unknown, args: Record<string, unknown> = {}) {
  return commitAger({ args, result, chars: JSON.stringify(result).length });
}

describe('project_run 结果老化', () => {
  it('成功时丢掉 ANSI 与用例日志噪音，保留退出码与 stdout 尾部', () => {
    const out = ageRun({
      stdout: `\u001b[32m ok \u001b[39m\n${'[AgentBuilder] noise\n'.repeat(50)}\n      Tests  8 passed (8)\n`,
      stderr: '[Knowledge] test log\n'.repeat(30),
      exitCode: 0,
      isolation: ISO,
      truncated: false,
      terminated: false,
      durationMs: 1234,
    })!;
    expect(out.startsWith('[aged] project_run exit 0'), '必须标注退出码').toBe(true);
    expect(out, 'ANSI 转义码必须剥掉').not.toContain('\u001b[');
    expect(out, '结论（测试汇总）必须保留').toContain('Tests  8 passed (8)');
    expect(out, '成功时 stderr 是用例日志噪音，不保留').not.toContain('[Knowledge]');
    expect(out, 'isolation 43/43 相同，属纯噪音').not.toContain('supervised-spawn');
    expect(out).not.toContain('durationMs');
  });

    it('失败时保留 stderr 尾部（诊断主体）', () => {
    const out = ageRun({
      stdout: 'build started\n',
      stderr: `${'warn: deprecation\n'.repeat(20)}Error: TS2304 Cannot find name 'foo'\n  at src/a.ts:12\n`,
      exitCode: 1,
      isolation: ISO,
      truncated: false,
      terminated: false,
    })!;
    expect(out).toContain('exit 1');
    expect(out, '失败原因必须保留').toContain('TS2304');
    expect(out).toContain('at src/a.ts:12');
    expect(out).toContain('stderr tail:');
  });

  it('截断与终止如实标注（不谎称输出完整）', () => {
    const out = ageRun({
      stdout: 'x'.repeat(1000),
      stderr: '',
      exitCode: 0,
      truncated: true,
      rawStdoutLength: 99999,
      terminated: true,
      terminateReason: 'timeout',
      isolation: ISO,
    })!;
    expect(out).toContain('stdout capped, 99999 chars total');
    expect(out).toContain('terminated (timeout)');
  });

  it('结构不符（无 exitCode）返回 undefined，保留原文', () => {
    expect(ageRun(null)).toBeUndefined();
    expect(ageRun({ stdout: 'x' })).toBeUndefined();
  });

  it('不膨胀：长输出必须显著变短', () => {
    const big = {
      stdout: `\u001b[90m\u001b[2m${'noise line with lots of padding text '.repeat(300)}`,
      stderr: '[AgentBuilder] x\n'.repeat(200),
      exitCode: 0,
      isolation: ISO,
      truncated: false,
      terminated: false,
    };
    const out = ageRun(big)!;
    expect(out.length, `${out.length} 必须远小于原文 ${JSON.stringify(big).length}`).toBeLessThan(
      JSON.stringify(big).length / 3,
    );
  });
});

describe('git_commit 结果老化', () => {
  it('保留 sha 与 subject（不可变锚点），丢弃与入参重复的 message', () => {
    const out = ageCommit({
      stdout: '[main 4c5eaf11] fix(gateway): run-instance security guard rebuild\n 15 files changed, 320 insertions(+), 36 deletions(-)\n create mode 100644 a.ts\n',
      stderr: '',
      exitCode: 0,
      isolation: ISO,
      stage: 'commit',
    })!;
    expect(out.startsWith('[aged git_commit]'), '必须带老化前缀').toBe(true);
    expect(out, 'sha 是定位这次提交的唯一锚点').toContain('[main 4c5eaf11]');
    expect(out).toContain('15 files changed, 320 insertions(+), 36 deletions(-)');
    expect(out, 'create mode 属文件事实，保留').toContain('create mode 100644 a.ts');
  });

  it('空 stdout 回落到「无输出」标记，不发 undefined', () => {
    const out = ageCommit({ stdout: '   ', stderr: '', exitCode: 0 })!;
    expect(out).toContain('no output');
  });

  it('结构不符返回 undefined', () => {
    expect(ageCommit(null)).toBeUndefined();
    expect(ageCommit({ stdout: 42 })).toBeUndefined();
  });
});
