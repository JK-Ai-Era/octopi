/**
 * 回声比对源必须看见 content block 正文（2026-11-13）
 *
 * 事故证据：真实摘要请求 1059 条消息中 1037 条（97.9%）的 content 是 block 数组；
 * 旧实现 `String(m.content)` 对数组返回 "[object Object]"，这些消息对闸门完全失明
 * ——闸门只对少数 string 形态消息有效，绝大多数正文可被逐字复读而不被发现。
 */
import { describe, it, expect } from 'vitest';
import { DefaultContextEngine } from '@octopi-agent/engine/harness';

/** 直接驱动私有 buildEchoSource（闸门输入的唯一来源） */
function echoSourceOf(engine: DefaultContextEngine, view: unknown[], sys = 'sys'): string {
  const fn = (engine as unknown as {
    buildEchoSource: (v: unknown[], s: string, a: unknown) => string;
  }).buildEchoSource.bind(engine);
  return fn(view, sys, { agedIds: new Set(), argsById: new Map(), agersByCallId: new Map(), argAgedIds: new Set() });
}

const inlineAging = { agedIds: new Set(), argsById: new Map(), agersByCallId: new Map(), argAgedIds: new Set() };

describe('回声比对源覆盖 block 正文', () => {
  it('content 为 text block 数组时，正文必须出现在比对源里', () => {
    const engine = new DefaultContextEngine({} as never);
    // 真实请求绝大多数消息是这种形态（convertMessage 对 block 内容原样转换）
    const longText = '装配出口收口把十六处重复表达式收敛为单一实现，避免手抄参数表漂移。'.repeat(2);
    const view = [
      { role: 'user', content: [{ type: 'text', text: longText }] },
    ];
    const src = echoSourceOf(engine, view);
    expect(src).toContain(longText);
    // 旧实现会退化成这个字符串，正文丢失
    expect(src).not.toContain('[object Object]');
  });

  it('多 block 拼接：每个 text block 都要进入比对源', () => {
    const engine = new DefaultContextEngine({} as never);
    const a = 'AAA'.repeat(20);
    const b = 'BBB'.repeat(20);
    const view = [{ role: 'assistant', content: [{ type: 'text', text: a }, { type: 'text', text: b }] }];
    const src = echoSourceOf(engine, view);
    expect(src).toContain(a);
    expect(src).toContain(b);
  });

  it('string 形态内容照旧保留（不得因修 block 而回归）', () => {
    const engine = new DefaultContextEngine({} as never);
    const text = '普通字符串正文'.repeat(10);
    const src = echoSourceOf(engine, [{ role: 'user', content: text }]);
    expect(src).toContain(text);
  });

  it('image 等无 text 的 block 不得产出 "[object Object]"', () => {
    const engine = new DefaultContextEngine({} as never);
    const view = [
      { role: 'user', content: [{ type: 'image', url: 'http://x/y.png' }, { type: 'text', text: 'X'.repeat(80) }] },
    ];
    const src = echoSourceOf(engine, view);
    expect(src).not.toContain('[object Object]');
    expect(src).toContain('X'.repeat(80));
  });

  it('回归锁定：block 正文可被逐字复读检测到（旧实现下失明）', () => {
    const engine = new DefaultContextEngine({} as never);
    const body = Array.from({ length: 12 }, (_, i) => `第 ${i} 行正文：装配出口已收口，重复表达式归一到单一实现。`);
    const view = [{ role: 'assistant', content: [{ type: 'text', text: body.join('\n') }] }];
    const src = echoSourceOf(engine, view);
    // 输出 = 该 block 原文（真实复读）
    const replay = body.join('\n');
    expect(src).toContain(replay);
  });
});
