/**
 * CLI 版本面：`--version` / `-v` / `octopi version` 的解析语义与单一版本源。
 *
 * 关键约束：`-v` 属于 version（行业惯例），verbose 只能用 `--verbose`。
 * 这条不对称必须由测试锁住——否则后人"顺手"把 -v 加回 verbose 就静默回退。
 */

import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import { getSuiteVersion } from '../src/cli/version.js';
import enginePackage from '@octopi-agent/engine/package.json' with { type: 'json' };

describe('parseArgs（version flags）', () => {
  it('--version 置 version 标记', () => {
    expect(parseArgs(['--version']).version).toBe(true);
  });

  it('-v 是 --version 的简写（不是 --verbose）', () => {
    const args = parseArgs(['-v']);
    expect(args.version).toBe(true);
    expect(args.verbose).toBe(false);
  });

  it('--verbose 仍可用且不触发 version', () => {
    const args = parseArgs(['--verbose']);
    expect(args.verbose).toBe(true);
    expect(args.version).toBe(false);
  });

  it('-v 与 --verbose 是两件不同的事，可同时出现', () => {
    const args = parseArgs(['-v', '--verbose']);
    expect(args.version).toBe(true);
    expect(args.verbose).toBe(true);
  });

  it('version 子命令走位置参数（不需要 flag）', () => {
    expect(parseArgs(['version']).command).toBe('version');
  });

  it('裸 octopi 不隐式触发 version（缺省 false）', () => {
    expect(parseArgs([]).version).toBe(false);
  });
});

describe('getSuiteVersion', () => {
  it('返回 engine 包版本（五包 lockstep，单一真相源）', () => {
    expect(getSuiteVersion()).toBe(enginePackage.version);
  });

  it('是合法的 X.Y.Z 语义版本串', () => {
    expect(getSuiteVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('同一进程内多次调用取同一值（不随调用漂移）', () => {
    expect(getSuiteVersion()).toBe(getSuiteVersion());
  });
});
