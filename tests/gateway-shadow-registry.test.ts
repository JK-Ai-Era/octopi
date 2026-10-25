/**
 * 影子查找守卫（P3）：gateway.ts 运行时不得读取 config.agents（注册表唯一权威）
 *
 * 背景：P2 拍板清零影子查找（config.agents 是 agents Map 的影子，双真相源会漂移）。
 * 本测试是回归锚——若将来有人恢复运行时影子读取，这里红灯。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('gateway 影子查找守卫', () => {
  it('gateway.ts 仅允许构造期 config.agents（组合根）与注释提及', () => {
    const source = readFileSync(
      join(__dirname, '../packages/gateway/src/gateway/gateway.ts'),
      'utf-8',
    );
    const offenders = source
      .split('\n')
      .map((line, i) => ({ text: line.trim(), no: i + 1 }))
      .filter(({ text }) => text.includes('config.agents'))
      // 允许：构造期组合根（createDefaultStore / 初始注册循环）与注释
      .filter(
        ({ text }) =>
          !text.startsWith('//') &&
          !text.includes('createDefaultStore') &&
          !text.includes('for (const agent of config.agents)'),
      );
    expect(
      offenders,
      `运行时 config.agents 影子读取回潮：${offenders.map((o) => `L${o.no}`).join(', ')} —— 改走 this.agents 注册表`,
    ).toEqual([]);
  });
});
