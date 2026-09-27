/**
 * CoalesceBuffer — 合批窗口（非执行队列）
 *
 * 同 (agentId, sessionId, coalesceKey) 在窗口内合并为一次 Run。
 * 有界；不同 agent 绝不合批。
 *
 * 模型 A：waiters 在 flush 完成后收到真实 DispatchResult（不吞 aborted/skipped）。
 */

import type { AgentEvent } from '../../core/primitives/event-bus.js';
import type { DispatchResult, Trigger } from './types.js';

export type CoalescePushResult<T = DispatchResult> =
  | { kind: 'no_key' }
  | { kind: 'buffer_full' }
  | { kind: 'merged' | 'created'; done: Promise<T> };

interface CoalesceEntry {
  key: string;
  triggers: Trigger[];
  timer: ReturnType<typeof setTimeout>;
  onFlush: (
    triggers: Trigger[],
    onEvent?: (event: AgentEvent) => void,
  ) => Promise<DispatchResult>;
  /** 窗口内以最后一次 push 的 onEvent 为准 */
  onEvent?: (event: AgentEvent) => void;
  waiters: Array<{ resolve: (r: DispatchResult) => void; reject: (e: unknown) => void }>;
}

export interface CoalesceOptions {
  defaultWindowMs?: number;
  maxEntries?: number;
}

export class CoalesceBuffer {
  private entries = new Map<string, CoalesceEntry>();
  private readonly defaultWindowMs: number;
  private readonly maxEntries: number;

  constructor(options: CoalesceOptions = {}) {
    this.defaultWindowMs = options.defaultWindowMs ?? 400;
    this.maxEntries = options.maxEntries ?? 256;
  }

  get size(): number {
    return this.entries.size;
  }

  push(params: {
    agentId: string;
    sessionId: string;
    trigger: Trigger;
    onFlush: (
      triggers: Trigger[],
      onEvent?: (event: AgentEvent) => void,
    ) => Promise<DispatchResult>;
    onEvent?: (event: AgentEvent) => void;
  }): CoalescePushResult {
    const { agentId, sessionId, trigger, onFlush, onEvent } = params;

    if (!trigger.coalesceKey) {
      return { kind: 'no_key' };
    }

    const key = [agentId, sessionId, trigger.coalesceKey].join('::');
    const existing = this.entries.get(key);
    if (existing) {
      existing.triggers.push(trigger);
      existing.onEvent = onEvent ?? existing.onEvent;
      const done = new Promise<DispatchResult>((resolve, reject) => {
        existing.waiters.push({ resolve, reject });
      });
      return { kind: 'merged', done };
    }

    if (this.entries.size >= this.maxEntries) {
      return { kind: 'buffer_full' };
    }

    const waiters: CoalesceEntry['waiters'] = [];
    const done = new Promise<DispatchResult>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });

    const entry: CoalesceEntry = {
      key,
      triggers: [trigger],
      onFlush,
      onEvent,
      waiters,
      timer: setTimeout(() => {
        void this.fire(entry);
      }, trigger.coalesceWindowMs ?? this.defaultWindowMs),
    };
    if (typeof entry.timer === 'object' && entry.timer !== null && 'unref' in entry.timer) {
      (entry.timer as NodeJS.Timeout).unref?.();
    }
    this.entries.set(key, entry);
    return { kind: 'created', done };
  }

  private async fire(entry: CoalesceEntry): Promise<void> {
    this.entries.delete(entry.key);
    clearTimeout(entry.timer);
    try {
      const result = await entry.onFlush(entry.triggers, entry.onEvent);
      for (const w of entry.waiters) w.resolve(result);
    } catch (err) {
      for (const w of entry.waiters) w.reject(err);
    }
  }

  stop(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      for (const w of entry.waiters) {
        w.resolve({ status: 'skipped', reason: 'runtime_stopped' });
      }
    }
    this.entries.clear();
  }
}
