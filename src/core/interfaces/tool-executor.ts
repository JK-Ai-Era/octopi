/**
 * ToolExecutor — 工具执行接口
 *
 * 职责：执行工具调用并返回结果。
 * 实现方：本地执行、沙盒执行、远程执行等。
 *
 * 安全约束通过 ExecutionContext 传递，Core 层强制校验。
 */

import type { ToolCall, ToolResult } from '../types.js';

// ── 执行上下文 ──

/** 工具执行上下文 — 安全约束 */
export interface ExecutionContext {
  /** 最大执行时间（毫秒） */
  timeoutMs: number;
  /** 文件系统访问范围（白名单目录） */
  allowedPaths?: string[];
  /** 网络访问范围（白名单 host） */
  allowedHosts?: string[];
  /** 环境变量白名单 */
  allowedEnvVars?: string[];
  /** 调用来源标识（用于权限追踪） */
  callerId?: string;
  /** 当前工作目录 */
  cwd?: string;
  /** 环境变量（过滤后的） */
  env?: Record<string, string>;
}

// ── 接口定义 ──

/**
 * ToolExecutor 接口
 *
 * Core 层在 Agent 循环中调用此接口执行工具。
 * SecurityGuard 在执行前后进行安全检查。
 */
export interface ToolExecutor {
  /**
   * 执行工具调用
   *
   * @param call - 工具调用请求（来自 LLM 的 tool_calls）
   * @param ctx - 执行上下文（安全约束）
   * @returns 工具执行结果
   * @throws 工具不存在、参数错误、执行超时等情况下抛出错误
   */
  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResult>;
}
