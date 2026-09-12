/**
 * 工具系统类型
 *
 * 工具定义、执行上下文、处理函数、注册记录。
 *
 * `ToolParameter` 保留字段用于参数校验：类型、必填、枚举、范围、长度、正则，以及嵌套对象与数组。
 */

/** 工具来源 */
export interface ToolSource {
  /** 来源类型 */
  kind: 'builtin' | 'plugin' | 'mcp' | 'subsystem' | 'custom';
  /** 来源标识（plugin ID / MCP server ID / subsystem ID） */
  origin: string;
  /** 信任级别 */
  trustLevel: 'builtin' | 'official' | 'third-party' | 'untrusted';
}

/** 工具参数定义 */
export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  enum?: Array<string | number>;
  properties?: Record<string, ToolParameter>;
  items?: ToolParameter;
  default?: unknown;
  /** 数值参数最小值（inclusive） */
  minimum?: number;
  /** 数值参数最大值（inclusive） */
  maximum?: number;
  /** 字符串最小长度 */
  minLength?: number;
  /** 字符串最大长度 */
  maxLength?: number;
  /** 字符串正则表达式（无首尾斜杠） */
  pattern?: string;
  /** 数组最少元素数 */
  minItems?: number;
  /** 数组最多元素数 */
  maxItems?: number;
}

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  permissions?: string[];
  requiresConfirmation?: boolean;
  timeoutMs?: number;
  /** 工具版本 */
  version?: string;
  /** 是否已废弃 */
  deprecated?: boolean;
  /** 废弃说明 */
  deprecatedMessage?: string;
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
  /** 工具来源（用于权限控制和可观测性） */
  source?: ToolSource;
}
