/**
 * createRunId 唯一性与形态钉（评审 del-5ca70159 P3-11）
 *
 * runId 自 v0.120.5 起是 historyAging run 起点边界的语义载体：两个 run 的 id
 * 碰撞会把它们并成同一个保护域。seq 是进程内计数（重启归零），同毫秒 + 同
 * 会话 + 重启的极端序列曾可碰撞；修复 = 插入随机段。
 *
 * 注：跨进程重启碰撞无法在单测内复现，此处钉「形态含随机段」+「同刻唯一」——
 * 旧格式（无随机段）会断言失败。
 */

import { describe, it, expect } from 'vitest';
import { createRunId } from '@octopi-agent/engine/harness/run/run-scope.js';

describe('createRunId（run 身份语义载体）', () => {
  it('同毫秒同会话连续生成不重复', () => {
    const a = createRunId('s1', 'a1', 1_700_000_000_000);
    const b = createRunId('s1', 'a1', 1_700_000_000_000);
    expect(a).not.toBe(b);
  });

  it('形态含随机段（run_<at>_<seq>_<rand>_<sessionId>_<agentId>）', () => {
    const id = createRunId('s1', 'a1', 1_700_000_000_000);
    // 三段才到 sessionId：旧格式只有两段（at/seq），此处必失败
    expect(id).toMatch(/^run_[0-9a-z]+_[0-9a-z]+_[0-9a-z]+_s1_a1$/);
  });
});
