/**
 * 工具系统类型
 *
 * 工具定义、执行上下文、处理函数、注册记录。
 */

/** 工具参数定义 */
export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  enum?: string[];
  properties?: Record<string, ToolParameter>;
  items?: ToolParameter;
  default?: unknown;
}

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  permissions?: string[];
  requiresConfirmation?: boolean;
  timeoutMs?: number;
}

/** 工具执行上下文 */
export interface ToolExecutionContext {
  sessionId: string;
  agentId: string;
  messages: import('./messages.js').Message[];
  abortSignal?: AbortSignal;
  cwd?: string;
}

/** 工具处理函数 */
export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<unknown>;

/** 已注册的工具 */
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}
