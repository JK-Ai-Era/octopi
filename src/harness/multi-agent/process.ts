/**
 * AgentProcess — Agent 进程运行时
 *
 * 将 AgentEngine 的一次运行包装为可追踪的进程。
 * 支持父子关系、完成通知（announce）、上下文分叉（fork）。
 *
 * 设计原则：
 * - 基于 ProcessModel 的生命周期，但不继承（组合优于继承）
 * - 结果通过 EventBus 推送给父进程（announce 模式）
 * - 支持 context fork：子进程继承父进程的消息历史
 * - 进程完成后不可重用（dead 终态）
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from '../../core/event-bus.js';
import type { Message } from '../../core/types.js';
import type { AgentEngine, RunConfig, EngineEvent } from '../../core/engine.js';
import type { AgentInfo } from '../../core/interfaces/agent-registry.js';

// ── 进程状态 ──

/** Agent 进程状态 */
export type AgentProcessState = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';

/** 进程完成信息 */
export interface AgentProcessResult {
  /** 最终回复内容 */
  content: string;
  /** 完整消息历史（含工具调用） */
  messages: Message[];
  /** 使用统计 */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** 运行时长（毫秒） */
  durationMs: number;
}

/** 进程完成事件数据 */
export interface AgentProcessAnnounce {
  /** 进程 ID */
  processId: string;
  /** 父进程 ID */
  parentId?: string;
  /** Agent 信息 */
  agentInfo: AgentInfo;
  /** 完成状态 */
  state: 'completed' | 'failed' | 'aborted';
  /** 完成结果（completed 时有值） */
  result?: AgentProcessResult;
  /** 错误信息（failed 时有值） */
  error?: string;
  /** 时间戳 */
  timestamp: number;
}

// ── 事件常量 ──

export const AgentProcessEvents = {
  /** 进程启动 */
  STARTED: 'agent_process.started',
  /** 进程完成（announce 核心事件） */
  COMPLETED: 'agent_process.completed',
  /** 进程失败 */
  FAILED: 'agent_process.failed',
  /** 进程中止 */
  ABORTED: 'agent_process.aborted',
  /** 子进程 spawn */
  CHILD_SPAWNED: 'agent_process.child_spawned',
} as const;

// ── 配置 ──

/** AgentProcess 配置 */
export interface AgentProcessConfig {
  /** 进程 ID（不传则自动生成） */
  id?: string;
  /** 父进程 ID */
  parentId?: string;
  /** Agent 信息 */
  agentInfo: AgentInfo;
  /** Agent 引擎 */
  engine: AgentEngine;
  /** EventBus（用于 announce） */
  events: EventBus;
  /** 系统提示词 */
  systemPrompt: string;
  /** 超时（毫秒，默认 0 = 不超时） */
  timeoutMs?: number;
  /** 是否启用 context fork（默认 false） */
  forkContext?: boolean;
}

// ── AgentProcess ──

/**
 * AgentProcess — Agent 进程运行时
 *
 * 用法：
 * ```ts
 * const process = new AgentProcess({
 *   agentInfo: coderAgent,
 *   engine: coderEngine,
 *   events: eventBus,
 *   systemPrompt: 'You are a coding assistant...',
 * });
 *
 * // 非阻塞启动
 * process.start(userMessages);
 *
 * // 监听完成事件
 * events.on(AgentProcessEvents.COMPLETED, (event) => {
 *   console.log(event.data.result);
 * });
 *
 * // 或等待完成
 * const result = await process.waitForCompletion();
 * ```
 */
export class AgentProcess {
  readonly id: string;
  readonly parentId?: string;
  readonly agentInfo: AgentInfo;

  private _engine: AgentEngine;
  private _events: EventBus;
  private _systemPrompt: string;
  private _timeoutMs: number;
  private _forkContext: boolean;

  private _state: AgentProcessState = 'pending';
  private _result?: AgentProcessResult;
  private _error?: string;
  private _startedAt?: number;
  private _completedAt?: number;
  private _abortController?: AbortController;
  private _completionResolvers: Array<(announce: AgentProcessAnnounce) => void> = [];

  constructor(config: AgentProcessConfig) {
    this.id = config.id ?? `proc-${randomUUID().slice(0, 8)}`;
    this.parentId = config.parentId;
    this.agentInfo = config.agentInfo;
    this._engine = config.engine;
    this._events = config.events;
    this._systemPrompt = config.systemPrompt;
    this._timeoutMs = config.timeoutMs ?? 0;
    this._forkContext = config.forkContext ?? false;
  }

  /** 当前状态 */
  get state(): AgentProcessState { return this._state; }

  /** 完成结果 */
  get result(): AgentProcessResult | undefined { return this._result; }

  /** 错误信息 */
  get error(): string | undefined { return this._error; }

  /** 运行时长（毫秒） */
  get durationMs(): number | undefined {
    if (!this._startedAt) return undefined;
    const end = this._completedAt ?? Date.now();
    return end - this._startedAt;
  }

  /**
   * 启动进程（非阻塞）
   *
   * @param messages - 输入消息
   * @param parentMessages - 父进程的消息历史（用于 context fork）
   * @returns this（链式调用）
   */
  start(messages: Message[], parentMessages?: Message[]): this {
    if (this._state !== 'pending') {
      throw new Error(`Process ${this.id} already started (state: ${this._state})`);
    }

    this._state = 'running';
    this._startedAt = Date.now();
    this._abortController = new AbortController();

    // 构建输入消息
    let inputMessages = [...messages];

    // Context fork：继承父进程的消息历史
    if (this._forkContext && parentMessages && parentMessages.length > 0) {
      inputMessages = [
        ...parentMessages,
        {
          role: 'system' as const,
          content: `[Context Fork] 以下是从父会话分叉的上下文。你继承了完整的对话历史，可以在此基础上继续工作。`,
          timestamp: Date.now(),
        },
        ...messages,
      ];
    }

    // 发射启动事件
    this._emit(AgentProcessEvents.STARTED, {
      processId: this.id,
      parentId: this.parentId,
      agentId: this.agentInfo.id,
    });

    // 异步运行（不 await，非阻塞）
    this._runAsync(inputMessages);

    return this;
  }

  /**
   * 中止进程
   */
  abort(): void {
    if (this._state !== 'running') return;
    this._abortController?.abort();
    this._state = 'aborted';
    this._completedAt = Date.now();
    this._emit(AgentProcessEvents.ABORTED, { processId: this.id });
    this._resolveCompletion();
  }

  /**
   * 等待进程完成（Promise 模式）
   */
  waitForCompletion(): Promise<AgentProcessAnnounce> {
    if (this._state !== 'running' && this._state !== 'pending') {
      return Promise.resolve(this._buildAnnounce());
    }

    return new Promise<AgentProcessAnnounce>((resolve) => {
      this._completionResolvers.push(resolve);
    });
  }

  // ── 内部方法 ──

  private async _runAsync(messages: Message[]): Promise<void> {
    try {
      const runConfig: RunConfig = {
        systemPrompt: this._systemPrompt,
        agentId: this.agentInfo.id,
        sessionId: this.id,
      };

      let content = '';
      const allMessages: Message[] = [...messages];

      // 带超时的运行
      const runPromise = this._collectRun(messages, runConfig);
      const result = this._timeoutMs > 0
        ? await this._withTimeout(runPromise, this._timeoutMs)
        : await runPromise;

      content = result.content;
      this._result = {
        content,
        messages: result.messages,
        usage: result.usage,
        durationMs: this.durationMs ?? 0,
      };

      this._state = 'completed';
      this._completedAt = Date.now();

      // Announce：推送完成事件
      const announce = this._buildAnnounce();
      this._emit(AgentProcessEvents.COMPLETED, { announce } as unknown as Record<string, unknown>);
      this._resolveCompletion();

    } catch (err) {
      if (this._state === 'aborted') return; // 已经处理过

      this._state = 'failed';
      this._completedAt = Date.now();
      this._error = err instanceof Error ? err.message : String(err);

      const announce = this._buildAnnounce();
      this._emit(AgentProcessEvents.FAILED, { announce } as unknown as Record<string, unknown>);
      this._resolveCompletion();
    }
  }

  private async _collectRun(
    messages: Message[],
    runConfig: RunConfig,
  ): Promise<{ content: string; messages: Message[]; usage?: AgentProcessResult['usage'] }> {
    let content = '';
    let usage: AgentProcessResult['usage'];

    for await (const event of this._engine.run(messages, runConfig, this._abortController?.signal)) {
      if (event.type === 'turn.end' && event.data) {
        content = (event.data.content as string) ?? '';
        usage = event.data.usage as AgentProcessResult['usage'];
      }
    }

    return { content, messages, usage };
  }

  private _buildAnnounce(): AgentProcessAnnounce {
    return {
      processId: this.id,
      parentId: this.parentId,
      agentInfo: this.agentInfo,
      state: this._state === 'completed' ? 'completed' : this._state === 'aborted' ? 'aborted' : 'failed',
      result: this._result,
      error: this._error,
      timestamp: Date.now(),
    };
  }

  private _resolveCompletion(): void {
    const announce = this._buildAnnounce();
    for (const resolver of this._completionResolvers) {
      resolver(announce);
    }
    this._completionResolvers = [];
  }

  private _emit(type: string, data?: Record<string, unknown>): void {
    this._events.emit({
      type,
      timestamp: Date.now(),
      agentId: this.agentInfo.id,
      sessionId: this.id,
      data,
    });
  }

  private _withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Process ${this.id} timeout after ${ms}ms`)), ms);
      promise.then(
        (result) => { clearTimeout(timer); resolve(result); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }
}

// ── 工厂函数 ──

/**
 * 创建并启动 AgentProcess
 */
export function spawnAgentProcess(
  config: Omit<AgentProcessConfig, 'id'> & { id?: string },
  messages: Message[],
  parentMessages?: Message[],
): AgentProcess {
  const process = new AgentProcess(config);
  process.start(messages, parentMessages);
  return process;
}

/**
 * 创建 context fork 子进程
 *
 * 从父进程的消息历史创建子进程，子进程继承父上下文。
 */
export function forkAgentProcess(
  config: Omit<AgentProcessConfig, 'forkContext'> & { forkContext?: boolean },
  messages: Message[],
  parentMessages: Message[],
): AgentProcess {
  return spawnAgentProcess(
    { ...config, forkContext: true },
    messages,
    parentMessages,
  );
}
