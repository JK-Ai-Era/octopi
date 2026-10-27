/**
 * SessionRunnerDispatcher — RunDispatcher 默认实现
 *
 * 包装 SessionAwareRunner；模型 A：串行互斥归 Runner 锁，本类不建队列。
 * inbox 只加速当前持锁 Run；原 Trigger 保留唤醒/重试语义（未消费项按原 Trigger 重投）。
 */

import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import type { SessionAwareRunner, RunConfig } from '../run/runner.js';
import type { RunDispatcher, RunRequest, Trigger } from './types.js';
import { SessionInbox } from './inbox.js';
import type { SessionInboxEntry, SessionInboxBinding } from './inbox.js';

export interface SessionRunnerDispatcherOptions {
  runner: SessionAwareRunner;
  runConfigDefaults?: Partial<RunConfig>;
  /** 未消费项回到 Runtime 的原 Trigger 路径（registerAgent 注入）。 */
  redispatch?: (
    trigger: Trigger,
    options?: { onEvent?: (event: AgentEvent) => void },
  ) => void | Promise<unknown>;
}

export class SessionRunnerDispatcher implements RunDispatcher {
  private readonly runner: SessionAwareRunner;
  private readonly defaults: Partial<RunConfig>;
  readonly inbox: SessionInbox;

  constructor(options: SessionRunnerDispatcherOptions) {
    this.runner = options.runner;
    this.defaults = options.runConfigDefaults ?? {};
    this.inbox = new SessionInbox(async (entry) => {
      if (!entry.trigger) {
        throw new Error(`inbox entry ${entry.id} has no original trigger for redispatch`);
      }
      await options.redispatch?.(
        entry.trigger,
        entry.onEvent ? { onEvent: entry.onEvent } : undefined,
      );
    });
  }

  async *execute(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const runConfig: RunConfig = {
      systemPrompt: '',
      ...this.defaults,
      agentId: req.agentId,
      sessionId: req.sessionId,
      model: req.modelOverride,
      modelProvider: req.modelProvider,
    };
    const entries: SessionInboxEntry[] = req.triggers.map((trigger, index) => ({
      id: trigger.id,
      agentId: req.agentId,
      sessionId: req.sessionId,
      message: req.messages[index]!,
      human: trigger.type === 'message' && trigger.payload.kind === 'user_message',
      triggerType: trigger.type,
      modelOverride: index === req.triggers.length - 1 ? req.modelOverride : undefined,
      modelProvider: index === req.triggers.length - 1 ? req.modelProvider : undefined,
      receivedAt: trigger.timestamp ?? Date.now(),
    }));
    for (const entry of entries) {
      if (signal?.aborted) return;
      const config = {
        ...runConfig,
        model: entry.modelOverride ?? runConfig.model,
        modelProvider: entry.modelProvider ?? runConfig.modelProvider,
      };
      // 每条各开各关：inbox 生命周期 ⊂ session 锁；合批后续条目不进前一条的接收队列
      const binding: SessionInboxBinding = {
        inbox: this.inbox,
        runId: `${req.requestId}:${entry.id}`,
        entries: [entry],
      };
      yield* this.runner.handle(req.sessionId, entry.message, config, signal, binding, entry);
    }
  }
}
