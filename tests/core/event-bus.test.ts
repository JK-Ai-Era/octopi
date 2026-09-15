/**
 * EventBus 机制测试（Core，开放信封）
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DefaultEventBus,
  ThrottledEventBus,
} from '../../src/core/primitives/event-bus.js';
import type { AgentEvent } from '../../src/core/primitives/event-bus.js';

describe('DefaultEventBus', () => {
  it('订阅与发射', () => {
    const bus = new DefaultEventBus();
    const handler = vi.fn();
    bus.on('test.event', handler);
    bus.emit({ type: 'test.event', timestamp: Date.now(), data: { value: 42 } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('取消订阅', () => {
    const bus = new DefaultEventBus();
    const handler = vi.fn();
    const sub = bus.on('test.event', handler);
    sub.dispose();
    bus.emit({ type: 'test.event', timestamp: Date.now() });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('ThrottledEventBus trailing', () => {
  it('窗口内 burst 只透传首条，并在窗口结束补发最后一条', async () => {
    const inner = new DefaultEventBus();
    const received: AgentEvent[] = [];
    inner.onAll((e) => received.push(e));

    const bus = new ThrottledEventBus(inner, {
      intervals: { 'llm_stream_delta': 40 },
    });

    bus.emit({ type: 'llm_stream_delta', timestamp: Date.now(), data: { delta: 'a' } });
    bus.emit({ type: 'llm_stream_delta', timestamp: Date.now(), data: { delta: 'b' } });
    bus.emit({ type: 'llm_stream_delta', timestamp: Date.now(), data: { delta: 'c' } });

    expect(received).toHaveLength(1);
    expect(received[0].data?.delta).toBe('a');

    await new Promise((r) => setTimeout(r, 60));
    bus.dispose();

    expect(received).toHaveLength(2);
    expect(received[1].data?.delta).toBe('c');
  });
});
