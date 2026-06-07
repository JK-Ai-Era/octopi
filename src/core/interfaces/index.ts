/**
 * Core 接口统一导出
 *
 * 这些接口是框架的契约基础。
 * Core 层依赖这些接口，Harness/Integration 层实现这些接口。
 */

export type {
  ModelProvider,
} from './model-provider.js';
export type {
  LLMRequest as ModelLLMRequest,
  LLMResponse as ModelLLMResponse,
  LLMMessage as ModelLLMMessage,
  LLMStreamChunk as ModelLLMStreamChunk,
  ToolDefinition as ModelToolDefinition,
} from './model-provider.js';

export type {
  ToolExecutor,
  ExecutionContext,
} from './tool-executor.js';

export type {
  ContextPipeline,
  PipelineInput,
  PipelineOutput,
  UntrustedRange,
} from './context-pipeline.js';

export type {
  ErrorStrategy,
  ErrorAction,
  OverflowAction,
  SecurityAction,
} from './error-strategy.js';

export type {
  Observer,
  Span,
  LogLevel,
  SpanStatus,
} from './observer.js';
export { Metrics } from './observer.js';

export type {
  SessionStore,
  SessionData,
} from './session-store.js';

export type {
  EventSource,
  EventSourceDescriptor,
  ExternalEvent,
} from './event-source.js';

export type {
  TaskStore,
  TaskRecord,
  TaskStatus,
  TaskPriority,
  TaskFilter,
} from './task-store.js';

export type {
  MessageChannel,
  ProcessMessage,
  MessageHandler,
} from './message-channel.js';

export type {
  AgentMessage,
  AgentMessageType,
  AgentMessageMetadata,
  AgentCommunicator,
} from './agent-message.js';
export { AgentMessageEvents } from './agent-message.js';
