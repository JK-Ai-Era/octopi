/**
 * TraceCollector — 从 AgentEngine 事件流自动收集 trace
 *
 * 包装 engine.run() 的 AsyncGenerator，旁路记录所有事件。
 * 不改变原始事件流的行为。
 */

import type { AgentEvent } from '../../core/event-bus.js';
import type { TraceEvent } from './trace-events.js';
import { TraceLogger, type TraceLoggerConfig } from './trace-logger.js';
import { TraceLevel, TRACE_EVENTS } from './trace-events.js';

export interface TraceCollectorConfig extends Partial<TraceLoggerConfig> {
  /** 是否记录流式 delta（数据量大，默认关闭） */
  captureStreamDeltas?: boolean;
  /** 是否记录完整的模型请求（含 messages，可能含敏感信息） */
  captureModelRequest?: boolean;
  /** 是否记录工具参数 */
  captureToolArgs?: boolean;
  /** 是否记录工具返回值 */
  captureToolResults?: boolean;
}

/**
 * TraceCollector
 */
export class TraceCollector {
  private logger: TraceLogger;
  private config: TraceCollectorConfig;
  private turnCount = 0;
  private currentTurnId?: string;

  constructor(config?: TraceCollectorConfig) {
    this.config = {
      captureStreamDeltas: false,
      captureModelRequest: false,
      captureToolArgs: true,
      captureToolResults: false,
      ...config,
    };
    this.logger = new TraceLogger(this.config);
  }

  /**
   * 包装引擎事件流，自动记录 trace
   *
   * @param events - 原始引擎事件流
   * @param ctx - 会话上下文
   * @yields 原始事件（不修改）
   */
  async *wrap(
    events: AsyncGenerator<AgentEvent>,
    ctx: { sessionId?: string; agentId?: string } = {},
  ): AsyncGenerator<AgentEvent> {
    const turnId = `turn_${++this.turnCount}`;
    this.currentTurnId = turnId;

    this.logger.info(TRACE_EVENTS.TURN_START, { turnId }, ctx);

    for await (const event of events) {
      // 记录到 trace
      this.recordEvent(event, ctx, turnId);

      // 原样传递
      yield event;
    }

    this.logger.info(TRACE_EVENTS.TURN_END, { turnId }, ctx);
  }

  /**
   * 记录单个事件
   */
  private recordEvent(
    event: AgentEvent,
    ctx: { sessionId?: string; agentId?: string },
    turnId: string,
  ): void {
    const base = {
      sessionId: event.sessionId ?? ctx.sessionId,
      agentId: event.agentId ?? ctx.agentId,
    };

    switch (event.type) {
      // ── 生命周期 ──
      case 'engine.start':
        this.logger.info(TRACE_EVENTS.ENGINE_START, event.data, base);
        break;

      case 'model.call.start':
        this.logger.info(TRACE_EVENTS.MODEL_CALL_START, {
          model: event.data?.model,
          turnId,
        }, base);
        break;

      case 'model.call.end':
        this.logger.info(TRACE_EVENTS.MODEL_CALL_END, {
          contentLength: (event.data?.content as string)?.length ?? 0,
          toolCallCount: event.data?.toolCallCount ?? 0,
          usage: event.data?.usage,
          turnId,
        }, base);
        break;

      case 'model.call.error':
        this.logger.error(TRACE_EVENTS.MODEL_CALL_ERROR, {
          error: event.data?.error,
          turnId,
        }, base);
        break;

      // ── 工具执行 ──
      case 'tool.exec.start':
        this.logger.info(TRACE_EVENTS.TOOL_EXEC_START, {
          toolName: event.data?.toolName,
          toolCallId: event.data?.toolCallId,
          turnId,
        }, base);
        break;

      case 'tool.exec.end':
        this.logger.info(TRACE_EVENTS.TOOL_EXEC_END, {
          toolName: event.data?.toolName,
          hasError: event.data?.hasError,
          turnId,
        }, base);
        break;

      // ── 流式 delta（TRACE 级别，数据量大） ──
      case 'llm_stream_delta':
        if (this.config.captureStreamDeltas) {
          this.logger.trace(TRACE_EVENTS.MODEL_STREAM_DELTA, {
            delta: event.data?.delta,
            turnId,
          }, base);
        }
        break;

      // ── 重试 ──
      case 'retry':
        this.logger.warn(TRACE_EVENTS.MODEL_RETRY, {
          delayMs: event.data?.delayMs,
          turnId,
        }, base);
        break;

      // ── 安全 ──
      case 'security.blocked':
        this.logger.error(TRACE_EVENTS.SECURITY_BLOCKED, event.data, base);
        break;

      // ── 预算 ──
      case 'budget.exceeded':
        this.logger.warn(TRACE_EVENTS.BUDGET_EXCEEDED, event.data, base);
        break;

      // ── 中止 ──
      case 'aborted':
        this.logger.warn('engine.aborted', event.data, base);
        break;

      // ── 其他 ──
      default:
        this.logger.debug(event.type, event.data, base);
        break;
    }
  }

  /**
   * 记录上下文构建（DEBUG 级别）
   */
  recordContext(ctx: {
    messageCount: number;
    estimatedTokens: number;
    systemPromptLength: number;
    toolCount: number;
    sessionId?: string;
    agentId?: string;
  }): void {
    this.logger.debug(TRACE_EVENTS.CONTEXT_BUILT, ctx, {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
    });
  }

  /**
   * 记录 Session 状态（DEBUG 级别）
   */
  recordSessionState(ctx: {
    sessionId: string;
    messageCount: number;
    turnCount: number;
    sessionSize?: string;
    agentId?: string;
  }): void {
    this.logger.debug(TRACE_EVENTS.SESSION_STATE, ctx, {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
    });
  }

  /**
   * 记录工具执行上下文（DEBUG 级别）
   */
  recordToolContext(ctx: {
    toolName: string;
    cwd?: string;
    sessionId?: string;
    agentId?: string;
    args?: Record<string, unknown>;
  }): void {
    const data: Record<string, unknown> = {
      toolName: ctx.toolName,
      cwd: ctx.cwd,
    };
    if (this.config.captureToolArgs && ctx.args) {
      data.args = ctx.args;
    }
    this.logger.debug(TRACE_EVENTS.TOOL_EXEC_CONTEXT, data, {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
    });
  }

  /**
   * 记录空回复（WARN 级别）
   */
  recordEmptyResponse(ctx: {
    sessionId?: string;
    agentId?: string;
    messageCount?: number;
    model?: string;
  }): void {
    this.logger.warn(TRACE_EVENTS.EMPTY_RESPONSE, ctx, {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
    });
  }

  /**
   * 获取底层 logger
   */
  getLogger(): TraceLogger {
    return this.logger;
  }

  /**
   * 结束 trace
   */
  finalize(): void {
    this.logger.finalize();
  }

  /**
   * 获取 trace 文件路径
   */
  getFilePath(): string | undefined {
    return this.logger.getFilePath();
  }

  /**
   * 获取已记录的事件数量
   */
  getEventCount(): number {
    return this.logger.getEventCount();
  }
}
