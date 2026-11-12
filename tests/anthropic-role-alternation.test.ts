/**
 * Anthropic 线上编码：角色交替归一（2026-11-12）
 *
 * 现场依据：一个 765 条消息的生产会话里，wire body 存在 17 处连续 user——
 * 全部来自引擎的常规形态，而不是异常数据：
 *   `tool_result` 块 → 摘要占位            （压缩后视图：工具结果紧跟摘要）
 *   摘要占位 → `turn_start`                 （旧格式残留 / 折叠边界）
 *   `turn_end` → `turn_start`              （连续 turn，中间无 assistant）
 *
 * Anthropic 官方会自行合并连续同角色，但严格端点（火山等 anthropic-messages 代理）
 * 只回通用 InvalidParameter（不指出 param），所以必须在适配器出口归一。
 *
 * 红线：合并只动线上编码，不改变内容顺序；非合并位置保持原有形态（纯文本仍是字符串），
 * 使字节变化收敛在真正需要合并的点（缓存只有一次冷启动代价）。
 */

import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '@octopi-agent/engine/integration/providers/anthropic.js';
import { mergeConsecutiveSameRole } from '@octopi-agent/engine/integration/providers/anthropic-message-normalize.js';

const provider = () => new AnthropicProvider({ apiKey: 'test', models: ['claude-sonnet-4-6'] });

describe('mergeConsecutiveSameRole（纯函数）', () => {
  it('相邻同角色 → 单条消息，content 按原顺序拼接为块', () => {
    const out = mergeConsecutiveSameRole([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    });
    // 非合并位置保持原形态（字符串），字节不变
    expect(out[1]).toEqual({ role: 'assistant', content: 'c' });
  });

  it('块数组与字符串混排也能拼接', () => {
    const out = mergeConsecutiveSameRole([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] },
      { role: 'user', content: 'after' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'x', content: 'r' },
      { type: 'text', text: 'after' },
    ]);
  });

  it('三段及以上连续同角色一次合并', () => {
    const out = mergeConsecutiveSameRole([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
    expect(out).toHaveLength(1);
    expect((out[0]!.content as unknown[]).length).toBe(3);
  });

  it('不改动输入数组（纯函数）', () => {
    const input = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ];
    mergeConsecutiveSameRole(input);
    expect(input[0]).toEqual({ role: 'user', content: 'a' });
    expect(input).toHaveLength(2);
  });
});

describe('Anthropic wire body：生产形态的连续 user', () => {
  it('turn_end → turn_start（连续 turn）合并为一条 user', () => {
    const body = provider().wireBodyFor(
      {
        messages: [
          { role: 'user', content: '<turn_start id="t1">…</turn_start>' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: '<turn_end id="t1"/>' },
          { role: 'user', content: '<turn_start id="t2">…</turn_start>' },
        ],
      },
      'chat',
    );
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    // turn_end 与 turn_start 同属一条 user：顺序保持
    expect(msgs[2]!.content).toEqual([
      { type: 'text', text: '<turn_end id="t1"/>' },
      { type: 'text', text: '<turn_start id="t2">…</turn_start>' },
    ]);
  });

  it('tool_result → 摘要占位（压缩后视图）合并且 tool_result 块在前', () => {
    const body = provider().wireBodyFor(
      {
        messages: [
          { role: 'user', content: '<turn_start id="t1">…</turn_start>' },
          {
            role: 'assistant',
            content: 'calling',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
          { role: 'tool', content: '', toolResults: [{ toolCallId: 'c1', name: 'f', result: 'R' }] } as never,
          { role: 'user', content: '[Conversation Summary]\n…' },
        ],
      },
      'chat',
    );
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const merged = msgs[2]!.content as Array<{ type: string }>;
    expect(merged[0]!.type).toBe('tool_result');
    expect(merged[1]!.type).toBe('text');
  });

  it('本来就交替的消息，线上字节与合并前完全一致（无缓存副作用）', () => {
    const body = provider().wireBodyFor(
      {
        messages: [
          { role: 'user', content: 'u1' },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'u2' },
        ],
      },
      'chat',
    );
    expect(body.messages).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ]);
  });

  it('连续 assistant（并行工具调用被拆开）也归并为一条', () => {
    const body = provider().wireBodyFor(
      {
        messages: [
          { role: 'user', content: 'u' },
          { role: 'assistant', content: 'a1' },
          { role: 'assistant', content: 'a2' },
        ],
      },
      'chat',
    );
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect((msgs[1]!.content as unknown[]).length).toBe(2);
  });
});
