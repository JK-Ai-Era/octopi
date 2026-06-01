/**
 * Agent Harness — 可嵌入的 Agent 底座框架
 *
 * 用法：
 * ```ts
 * import { Agent, createHttpProtocol } from 'agent-harness';
 *
 * const agent = new Agent();
 * agent.registerProvider(myLLMProvider);
 * agent.registerTool(myTool);
 *
 * const session = await agent.createSession({ ... });
 * const reply = await agent.send(session.id, { role: 'user', content: '你好' });
 * ```
 */

// Core
export { Agent } from './core/agent.js';
export { SessionManager } from './core/session-manager.js';
export type {
  Message,
  MessageRole,
  MessageSource,
  ToolCall,
  ToolResult,
  AgentPersona,
  AgentConfig,
  Turn,
  TokenUsage,
  Session,
  SessionStatus,
  ContextWindow,
  ToolParameter,
  ToolDefinition,
  ToolExecutionContext,
  ToolHandler,
  RegisteredTool,
  MemoryConfig,
  MemoryQuery,
  MemoryEntry,
  VectorStoreConfig,
  LLMRequest,
  LLMResponse,
  LLMProvider,
  AgentEvent,
  AgentEventListener,
  AgentHarness,
} from './core/types.js';

// Tools
export { ToolRegistry } from './tools/tool-registry.js';

// Providers
export { LLMRouter } from './providers/llm-router.js';

// Memory
export { ContextManager } from './memory/context-manager.js';

// Protocol
export { HttpProtocol, createHttpProtocol } from './protocol/http.js';
