/**
 * HookContext — 插件钩子上下文
 *
 * Harness 层类型。传递给插件钩子函数的执行上下文。
 */

export interface HookContext {
  sessionId: string;
  agentId: string;
  [key: string]: unknown;
}
