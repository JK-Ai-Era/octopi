/**
 * SessionRunnerDispatcher — RunDispatcher 默认实现
 *
 * 包装 SessionAwareRunner；模型 A：串行互斥归 Runner 锁，本类不建队列。
 */

import type { AgentEvent } from '../../core/primitives/event-bus.js';
import type { SessionAwareRunner, RunConfig } from '../runner.js';
import type { RunDispatcher, RunRequest } from './types.js';

export interface SessionRunnerDispatcherOptions {
  runner: SessionAwareRunner;
  /** 供 RunConfig.systemPrompt 等 */
  runConfigDefaults?: Partial<RunConfig>;
}

export class SessionRunnerDispatcher implements RunDispatcher {
  private readonly runner: SessionAwareRunner;
  private readonly defaults: Partial<RunConfig>;

  constructor(options: SessionRunnerDispatcherOptions) {
    this.runner = options.runner;
    this.defaults = options.runConfigDefaults ?? {};
  }

  async *execute(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const runConfig: RunConfig = {
      systemPrompt: '',
      ...this.defaults,
      // request 字段必须最后写入，防止 defaults 覆盖
      agentId: req.agentId,
      sessionId: req.sessionId,
    };

    // 合批多条：按序各 handle 一次（同 session，Runner 锁保证串行）
    // 无 coalesceKey 的单条路径与今日 Gateway 一致
    for (const message of req.messages) {
      if (signal?.aborted) return;
      yield* this.runner.handle(req.sessionId, message, runConfig, signal);
    }
  }
}
