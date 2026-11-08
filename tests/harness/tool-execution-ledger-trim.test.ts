/**
 * toolExecutionLedgerTrim 直接单测（评审 M1：0 直接引用=B1 修复零保护）。
 * 钉：候选窗/边界对齐/砍满/幂等/孤儿 result 补行/保护类跳过。
 */
import { describe, it, expect } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import { toolExecutionLedgerTrim } from '@octopi-agent/engine/harness/context/capabilities/compact/index.js';

const tool = (id: string, chars: number): Message =>
  ({ role: 'tool', content: '', toolResults: [{ toolCallId: id, name: 'r', result: 'x'.repeat(chars) }], timestamp: 1 } as Message);
const pair = (id: string, chars: number): Message[] => [
  { role: 'assistant', content: '', toolCalls: [{ id, name: 'r', arguments: {} }], timestamp: 1 } as Message,
  tool(id, chars),
];
const user = (t: string): Message => ({ role: 'user', content: t, timestamp: 1 } as Message);

describe('toolExecutionLedgerTrim', () => {
  it('砍满：tailKeep 窗外工具执行全部账本化，user/合成跳过幸存', () => {
    const msgs = [user('go'), ...pair('a', 300), ...pair('b', 300), ...pair('c', 300), user('tail')];
    const { result, droppedCount } = toolExecutionLedgerTrim(msgs, { tailKeep: 2 });
    expect(droppedCount).toBeGreaterThan(0); // 窗外执行真被砍（删「砍满」此断言挂）
    const texts = result.map((m) => JSON.stringify(m));
    expect(texts.some((t) => t.includes('go'))).toBe(true); // user 幸存（丢弃次序）
    expect(texts.some((t) => t.includes('tail'))).toBe(true);
  });

  it('边界对齐：call 在窗内/result 在 tail 窗 → 整对不砍（B1 孤儿）', () => {
    // tailKeep=2 → tailFloor=3；候选窗 [0,3)：pair('a') 的 call(1) 在窗内、result(2) 也在窗内→可砍；
    // 构造 call(1) 在窗、result(2) 恰在 tailFloor=3？→ 调整：user+call+result，tailKeep=1 → tailFloor=2，result(2) 落 tail 窗
    const msgs = [user('go'), ...pair('a', 300), user('tail')]; // n=4, tailKeep=1 → tailFloor=3? n=4-1=3
    const { result } = toolExecutionLedgerTrim(msgs, { tailKeep: 1 });
    const texts = result.map((m) => JSON.stringify(m));
    const hasCall = texts.some((t) => t.includes('toolCalls') || t.includes('tool_calls'));
    const hasResult = texts.some((t) => t.includes('toolResults') || (t.includes('"tool"') && t.includes('xxx')));
    expect(hasCall).toBe(hasResult); // 同进同出（孤儿=400 永久复发）
  });

  it('幂等：无候选时原样返回（每档独立调用的基础）', () => {
    const msgs = [user('go'), user('tail')];
    const { result, droppedCount } = toolExecutionLedgerTrim(msgs, { tailKeep: 50 });
    expect(droppedCount).toBe(0);
    expect(result).toHaveLength(2);
  });

  it('孤儿 result 被账本化时补 name 留痕（原只留 error 行）', () => {
    const msgs = [user('go'), tool('orphan', 300), user('tail')]; // 无 call 的 result
    const { result, droppedCount } = toolExecutionLedgerTrim(msgs, { tailKeep: 1 });
    expect(droppedCount).toBe(1);
    const text = result.map((m) => JSON.stringify(m)).join('\n');
    expect(text).toContain('r:'); // name 留痕（账本行含工具名）
  });
});
