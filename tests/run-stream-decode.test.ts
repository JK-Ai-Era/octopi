/**
 * m1 流终态校验锚（OP-P0B-1 ⑥ 残余）：decodeRunStream 是 /runs NDJSON 流的唯一消费端——
 * 截断 ≠ 成功；未知 entry type fail-loud；错误文案带上下文。
 */
import { describe, it, expect } from 'vitest';
import { decodeRunStream } from '@octopi-agent/gateway/gateway/remote-run-backend.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';

function chunks(...lines: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  return (async function* () {
    for (const line of lines) yield enc.encode(`${line}\n`);
  })();
}

const ev = (n: number): string =>
  JSON.stringify({ type: 'event', event: { type: 'log', message: `e${n}` } as unknown as AgentEvent });

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('decodeRunStream 终态校验（m1）', () => {
  it('事件若干 + done 终态：全部产出后干净返回', async () => {
    const events = await collect(decodeRunStream(chunks(ev(1), ev(2), '{"type":"done"}'), 'session s1'));
    expect(events).toHaveLength(2);
  });

  it('流干净结束但无终态 entry：throw（截断 ≠ 成功）', async () => {
    await expect(collect(decodeRunStream(chunks(ev(1)), 'session s1'))).rejects.toThrow(
      /without terminal entry.*truncated.*session s1/,
    );
  });

  it('error 终态：throw 且文案带上下文，name（分类字段）保留', async () => {
    const err = await collect(
      decodeRunStream(
        chunks(ev(1), '{"type":"error","error":{"message":"run aborted","name":"AbortError"}}'),
        'session s1',
      ),
    ).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/run aborted.*session s1/);
    expect(err?.name).toBe('AbortError'); // F3：wire name 不得被丢弃（中止≠失败可区分）
  });

  it('坏行：throw 且带上下文（不裸抛 SyntaxError）', async () => {
    await expect(
      collect(decodeRunStream(chunks(ev(1), 'not-json', '{"type":"done"}'), 'session s1')),
    ).rejects.toThrow(/malformed stream entry.*session s1/);
  });

  it('未知 entry type：fail-loud throw（不静默当 done）', async () => {
    await expect(
      collect(decodeRunStream(chunks(ev(1), '{"type":"mystery"}', '{"type":"done"}'), 'session s1')),
    ).rejects.toThrow(/unknown stream entry type "mystery"/);
  });

  it('跨 chunk 半行不误判：缓冲拼接后再解码', async () => {
    const enc = new TextEncoder();
    const body = (async function* () {
      yield enc.encode(`${ev(1)}\n{"ty`);
      yield enc.encode('pe":"done"}\n');
    })();
    const events = await collect(decodeRunStream(body, 'session s1'));
    expect(events).toHaveLength(1);
  });
});
