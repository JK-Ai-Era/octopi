/**
 * SessionInbox — 给持锁的活跃 Run 接续消息。
 *
 * 原 Trigger 是唤醒/重试凭证：offer 未被活跃 Run 接收时，调用方照常 dispatch；
 * 被接收后由活跃 Run 在下一个合法消息边界消费，Run 关闭仍未消费/未确认
 * （ack = 已入父上下文且转录同步成功）则按原 Trigger 重投。
 * 本队列不是第二执行引擎——不持锁不开箱，不改写已发出的模型请求。
 */

import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { Trigger } from './types.js';

export type InboxOfferResult = 'steered' | 'dispatched' | 'duplicate';

export interface SessionInboxSignal {
  agentId: string;
  sessionId: string;
  message: Message;
  /** trigger.id / delegationId 去重；同 id 只进一次父上下文。 */
  entryId?: string;
  /** 真人输入优先于机器结果。 */
  human?: boolean;
  triggerType?: Trigger['type'];
  /** 消息级模型覆盖；与活跃 Run 同模型时仍可接续（会话级选择 ≠ 显式换模型）。 */
  modelOverride?: string;
  modelProvider?: string;
  /** 原 Trigger：Run 关闭未确认时按它重投，保留附件等完整来源。 */
  trigger?: Trigger;
  /** 调用方的收尾通道（频道回复捕获等）；消费时由 Runner 转发事件。 */
  onEvent?: (event: AgentEvent) => void;
  onAdmitted?: (delivery: 'steered') => void;
}

export interface SessionInboxEntry {
  readonly id: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly message: Message;
  readonly human: boolean;
  readonly triggerType?: Trigger['type'];
  readonly modelOverride?: string;
  readonly modelProvider?: string;
  readonly trigger?: Trigger;
  readonly onEvent?: (event: AgentEvent) => void;
  readonly receivedAt: number;
}

export interface SessionInboxRun {
  readonly runId: string;
  readonly inbox: SessionInbox;
  readonly closed: boolean;
  drain(): SessionInboxEntry[];
  take(entryId: string): SessionInboxEntry | undefined;
  close(): void;
}

/** Dispatcher 创建；Runner 拿锁后 open，释放锁前 close（生命周期 ⊂ session 锁）。 */
export interface SessionInboxBinding {
  readonly inbox: SessionInbox;
  readonly runId: string;
  readonly entries: SessionInboxEntry[];
}

interface RunModelFingerprint {
  model?: string;
  provider?: string;
}

interface UnackedRecord {
  entry: SessionInboxEntry;
  runId: string;
}

function keyOf(agentId: string, sessionId: string): string {
  return JSON.stringify([agentId, sessionId]);
}

function compareEntries(a: SessionInboxEntry, b: SessionInboxEntry): number {
  // 人话先于机器结果；同来源保持到达顺序。
  if (a.human !== b.human) return a.human ? -1 : 1;
  return a.receivedAt - b.receivedAt;
}

export class SessionInbox {
  private readonly active = new Map<
    string,
    {
      runId: string;
      runModel: RunModelFingerprint | undefined;
      state: { pending: SessionInboxEntry[]; closed: boolean };
    }
  >();
  private readonly pending = new Map<string, SessionInboxEntry[]>();
  private readonly redispatching = new Map<string, Promise<void>>();
  private readonly owned = new Set<string>();
  private readonly delivered = new Set<string>();
  /** drain/take 出队但尚未 ack 的条目；Run 关闭未确认时回队重投（at-least-once）。 */
  private readonly unacked = new Map<string, UnackedRecord>();

  constructor(
    private readonly redispatch: (
      entry: SessionInboxEntry,
    ) => void | Promise<unknown>,
    private readonly idLimit = 4096,
  ) {}

  /**
   * 有兼容的活跃接收端才接收（返回 steered）；否则调用方继续原 Trigger。
   * duplicate = 同 id 已被接收或已入上下文，不得再次执行。
   * 兼容性：显式换模型（≠ 活跃 Run 模型）/ 带附件输入不接续，走完整新 Run。
   */
  offer(signal: SessionInboxSignal): InboxOfferResult {
    const id = signal.entryId ?? signal.trigger?.id ?? `inbox-${randomUUID()}`;
    if (this.owned.has(id) || this.delivered.has(id)) return 'duplicate';
    const active = this.active.get(keyOf(signal.agentId, signal.sessionId));
    const modelSwitch =
      signal.modelOverride !== undefined &&
      (signal.modelOverride !== active?.runModel?.model ||
        signal.modelProvider !== active?.runModel?.provider);
    if (!active || modelSwitch || signal.message.metadata?.attachmentIds != null) {
      return 'dispatched';
    }
    const entry: SessionInboxEntry = {
      id,
      agentId: signal.agentId,
      sessionId: signal.sessionId,
      message: signal.message,
      human: signal.human ?? false,
      triggerType: signal.triggerType ?? signal.trigger?.type,
      modelOverride: signal.modelOverride,
      modelProvider: signal.modelProvider,
      trigger: signal.trigger,
      onEvent: signal.onEvent,
      receivedAt: Date.now(),
    };
    this.owned.add(id);
    active.state.pending.push(entry);
    signal.onAdmitted?.('steered');
    return 'steered';
  }

  /** 仅 Runner 持锁后调用；同 (agent, session) 同时只有一个接收端。 */
  open(
    sessionId: string,
    agentId: string,
    runId: string,
    entries: SessionInboxEntry[],
    runModel?: RunModelFingerprint,
  ): SessionInboxRun {
    const key = keyOf(agentId, sessionId);
    if (this.active.has(key)) throw new Error(`inbox run already open: ${key}`);
    const state = {
      closed: false,
      pending: entries.filter((entry) => !this.delivered.has(entry.id)),
    };
    for (const entry of state.pending) this.owned.add(entry.id);
    this.active.set(key, { runId, runModel, state });
    const claim = (entry: SessionInboxEntry): SessionInboxEntry => {
      this.unacked.set(entry.id, { entry, runId });
      return entry;
    };
    return {
      runId,
      inbox: this,
      get closed() {
        return state.closed;
      },
      drain: () => state.pending.splice(0).sort(compareEntries).map(claim),
      take: (entryId) => {
        const index = state.pending.findIndex((entry) => entry.id === entryId);
        if (index < 0) return undefined;
        const entry = state.pending.splice(index, 1)[0]!;
        // 初始输入由本次 Run 全权负责（失败走 RUN_FAILED/上层重试），
        // 不进 unacked 重投；此处释放 owned 防首同步前退出时 id 残留（评审 F8）
        this.owned.delete(entry.id);
        return entry;
      },
      close: () => {
        if (state.closed) return;
        state.closed = true;
        this.active.delete(key);
        // 未消费（pending）+ 已取走但未确认（unacked）都按原 Trigger 重投：
        // ack 只认「已入父上下文且转录同步成功」，其余一律 at-least-once。
        const requeue: SessionInboxEntry[] = [...state.pending.splice(0)];
        for (const [id, record] of this.unacked) {
          if (record.runId !== runId) continue;
          this.unacked.delete(id);
          if (this.delivered.has(id)) continue;
          requeue.push(record.entry);
        }
        for (const entry of requeue) {
          this.owned.delete(entry.id);
          if (this.delivered.has(entry.id)) continue;
          const queue = this.pending.get(key) ?? [];
          if (!queue.some((item) => item.id === entry.id)) queue.push(entry);
          this.pending.set(key, queue);
        }
        this.schedule(key);
      },
    };
  }

  /** 消息已进父上下文且转录同步成功才调用；送达去重与 surfaced 的因果锚点。 */
  ack(entry: SessionInboxEntry): void {
    this.unacked.delete(entry.id);
    this.owned.delete(entry.id);
    this.delivered.add(entry.id);
    while (this.delivered.size > this.idLimit) {
      const oldest = this.delivered.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delivered.delete(oldest);
    }
  }

  isDelivered(entryId: string): boolean {
    return this.delivered.has(entryId);
  }

  /** close 重投：每个待投项独立 await；重复投递由 offer 的 delivered 检查兜底。 */
  private schedule(key: string): void {
    if (this.redispatching.has(key) || !this.pending.get(key)?.length) return;
    const task = (async () => {
      while (true) {
        const entry = this.pending.get(key)?.shift();
        if (!entry) break;
        if (!this.pending.get(key)?.length) this.pending.delete(key);
        if (this.delivered.has(entry.id)) continue;
        await this.redispatch(entry);
      }
    })()
      .catch((error: unknown) => {
        console.warn(
          `[SessionInbox] redispatch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.redispatching.delete(key);
        this.schedule(key);
      });
    this.redispatching.set(key, task);
  }
}
