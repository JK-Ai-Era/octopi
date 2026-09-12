/**
 * ToolBus — 工具总线接口
 *
 * 统一的工具发现、注册、策略过滤、格式转换入口。
 * Core 层定义接口契约，Harness 层提供 DefaultToolBus 实现。
 *
 * 职责边界：
 * - ToolBus 负责工具的注册、发现、过滤、格式转换
 * - 工具执行的安全检查由 beforeToolCall 回调链负责（不在 ToolBus 内）
 * - ToolBus 是无状态服务，不持有运行时执行状态
 *
 * @module core/interfaces/tool-bus
 */

import type {
  RegisteredTool,
  ToolDefinition,
  ToolPolicy,
} from '../types.js';

/**
 * ToolBus 接口
 *
 * 替代原先散落在 ToolRegistry / ToolSet / Builder 中的
 * 工具注册、查找、格式转换逻辑，提供统一入口。
 *
 * 实现方可扩展 validateArgs / execute 等方法（不在接口中），
 * 供内部消费方（如 MCP 桥接、参数校验）直接使用。
 */
export interface ToolBus {
  // ── 注册 ──

  /**
   * 注册工具（全局）
   *
   * 重复注册同名工具时抛出异常（严格模式）。
   * Agent 级注册使用 registerForAgent()，允许覆盖同名全局工具。
   */
  register(tool: RegisteredTool): void;

  /** 批量注册工具 */
  registerAll(tools: RegisteredTool[]): void;

  /**
   * 按 agentId 注册工具
   *
   * Agent 级工具覆盖同名全局工具（静默覆盖，不抛异常）。
   * resolve() 和 listForAgent() 合并时，agent 级优先。
   */
  registerForAgent(agentId: string, tool: RegisteredTool): void;

  /** 注销工具 */
  unregister(name: string, agentId?: string): boolean;

  // ── 查询 ──

  /** 获取单个工具（agent 级优先） */
  getTool(name: string, agentId?: string): RegisteredTool | undefined;

  /** 列出 agent 可用的所有工具（合并全局 + agent 级） */
  listForAgent(agentId: string): RegisteredTool[];

  // ── 解析 ──

  /**
   * 按 agentId + policy 解析出最终可用工具列表
   *
   * 合并全局和 agent 级工具后，应用 ToolPolicy 的 allow/deny 过滤。
   */
  resolve(agentId: string, policy?: ToolPolicy): RegisteredTool[];

  /**
   * 解析并转换为 LLM function calling 格式
   *
   * 等价于 resolve() 后转为 OpenAI function calling schema。
   */
  toLLMDefinitions(agentId: string, policy?: ToolPolicy): unknown[];
}
