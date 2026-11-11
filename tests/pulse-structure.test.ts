/**
 * P0c 结构性断言（arch/service-topology-p0c.md §1 验收 3 / §5.4 前置条件）：
 * run 实例装配面**零 self-arm 定时器**——backfill-trigger / health-probe / sense engine
 * 三个源文件不得出现 `setInterval(`（周期任务一律由 gateway 脉搏单发驱动）。
 *
 * 这是防复发锚：谁把定时器 arm 回来，此测试红。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..');
const TARGETS = [
  'packages/engine/src/harness/memory/backfill-trigger.ts',
  'packages/engine/src/harness/memory/health-probe.ts',
  'packages/engine/src/harness/collaboration/autonomous-subsystem/sense/engine.ts',
];

describe('P0c structural invariant: zero self-armed timers in run-instance assembly', () => {
  for (const rel of TARGETS) {
    it(`${rel} contains no setInterval(`, () => {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      // 排除注释行里的提及（如「替代原 …… setInterval」），只看代码面
      const codeLines = text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'));
      const offending = codeLines.filter((line) => line.includes('setInterval('));
      expect(offending, `self-armed timer reintroduced in ${rel}`).toEqual([]);
    });
  }
});
