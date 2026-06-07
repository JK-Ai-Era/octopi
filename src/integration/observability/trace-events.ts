/**
 * Trace Events — 可观测性事件定义
 *
 * 分级事件系统：
 *   Level 0: FATAL  — 系统崩溃
 *   Level 1: ERROR  — 功能异常（空回复、工具失败）
 *   Level 2: WARN   — 可降级问题（重试、fallback）
 *   Level 3: INFO   — 关键节点（turn 开始/结束、tool 调用）
 *   Level 4: DEBUG  — 完整数据（消息内容、token 统计）
 *   Level 5: TRACE  — 底层细节（原始 API 请求/响应、流式 chunk）
 */

/** Trace 级别枚举 */
export enum TraceLevel {
  FATAL = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
  TRACE = 5,
}

/** Trace 级别名称 */
export const TRACE_LEVEL_NAMES: Record<TraceLevel, string> = {
  [TraceLevel.FATAL]: 'FATAL',
  [TraceLevel.ERROR]: 'ERROR',
  [TraceLevel.WARN]: 'WARN',
  [TraceLevel.INFO]: 'INFO',
  [TraceLevel.DEBUG]: 'DEBUG',
  [TraceLevel.TRACE]: 'TRACE',
};

/** Trace 事件基础结构 */
export interface TraceEvent {
  /** 时间戳 */
  ts: number;
  /** Trace 级别 */
  level: TraceLevel;
  /** 事件类型 */
  type: string;
  /** Session ID */
  sessionId?: string;
  /** Agent ID */
  agentId?: string;
  /** 事件数据 */
  data?: Record<string, unknown>;
}

// ── 预定义事件类型 ──

/** 生命周期事件 */
export const TRACE_EVENTS = {
  // Level 3: INFO — 关键节点
  ENGINE_START: 'engine.start',
  ENGINE_END: 'engine.end',
  TURN_START: 'turn.start',
  TURN_END: 'turn.end',
  MODEL_CALL_START: 'model.call.start',
  MODEL_CALL_END: 'model.call.end',
  TOOL_EXEC_START: 'tool.exec.start',
  TOOL_EXEC_END: 'tool.exec.end',
  SESSION_LOAD: 'session.load',
  SESSION_SAVE: 'session.save',

  // Level 2: WARN
  MODEL_RETRY: 'model.retry',
  MODEL_FALLBACK: 'model.fallback',
  EMPTY_RESPONSE: 'empty.response',
  TOOL_ERROR: 'tool.error',

  // Level 1: ERROR
  MODEL_CALL_ERROR: 'model.call.error',
  SECURITY_BLOCKED: 'security.blocked',
  BUDGET_EXCEEDED: 'budget.exceeded',

  // Level 4: DEBUG
  CONTEXT_BUILT: 'context.built',
  MESSAGES_SERIALIZED: 'messages.serialized',
  SESSION_STATE: 'session.state',
  TOOL_EXEC_CONTEXT: 'tool.exec.context',

  // Level 5: TRACE
  MODEL_REQUEST: 'model.request',
  MODEL_STREAM_DELTA: 'model.stream.delta',
  MODEL_RESPONSE_RAW: 'model.response.raw',
  TOOL_RESULT_RAW: 'tool.result.raw',
} as const;

/**
 * 从引擎事件类型映射到 Trace 级别
 */
export function getTraceLevelForEngineEvent(eventType: string): TraceLevel {
  // 基于事件类型推断级别
  if (eventType.includes('stream.delta') || eventType.includes('stream_delta')) return TraceLevel.TRACE;
  if (eventType.includes('request') || eventType.includes('response.raw')) return TraceLevel.TRACE;
  if (eventType.includes('context.') || eventType.includes('session.state')) return TraceLevel.DEBUG;
  if (eventType.includes('error') || eventType.includes('blocked')) return TraceLevel.ERROR;
  if (eventType.includes('retry') || eventType.includes('fallback')) return TraceLevel.WARN;
  if (eventType.includes('budget')) return TraceLevel.WARN;
  return TraceLevel.INFO;
}
