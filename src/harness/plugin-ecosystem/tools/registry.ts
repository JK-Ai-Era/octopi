/**
 * 工具注册中心
 *
 * 管理所有已注册的工具，支持：
 * - 全局工具和 Agent 级工具（Agent 级覆盖同名全局工具）
 * - 工具策略（白名单/黑名单/确认机制）
 * - LLM function calling 格式转换
 * - 参数校验
 *
 * 工具的优先级：
 *   Agent 级工具 > 全局工具
 *
 * 使用方式：
 * ```ts
 * const registry = new ToolRegistry();
 *
 * // 注册全局工具
 * registry.register({ definition: { ... }, handler: async () => ... });
 *
 * // 注册 Agent 级工具（覆盖同名全局工具）
 * registry.register({ definition: { ... }, handler: async () => ... }, 'agent-1');
 *
 * // 执行工具
 * const result = await registry.execute('tool_name', { arg: 'value' }, context);
 * ```
 */

import type { RegisteredTool, ToolDefinition, ToolExecutionContext } from '../../../core/types.js';

export class ToolRegistry {
  /** 全局工具 */
  private globalTools = new Map<string, RegisteredTool>();
  /** Agent 级工具（agentId → 工具映射） */
  private agentTools = new Map<string, Map<string, RegisteredTool>>();

  /**
   * 注册工具
   *
   * @param tool - 工具定义和处理函数
   * @param agentId - Agent ID（不传则为全局工具）
   * @throws 重复注册同名全局工具时抛出错误
   */
  register(tool: RegisteredTool, agentId?: string): void {
    const { name } = tool.definition;

    if (agentId) {
      if (!this.agentTools.has(agentId)) {
        this.agentTools.set(agentId, new Map());
      }
      this.agentTools.get(agentId)!.set(name, tool);
    } else {
      if (this.globalTools.has(name)) {
        throw new Error(`Global tool "${name}" already registered`);
      }
      this.globalTools.set(name, tool);
    }
  }

  /**
   * 注销工具
   */
  unregister(name: string, agentId?: string): boolean {
    if (agentId) {
      return this.agentTools.get(agentId)?.delete(name) ?? false;
    }
    return this.globalTools.delete(name);
  }

  /**
   * 获取工具（优先返回 Agent 级工具）
   */
  get(name: string, agentId?: string): RegisteredTool | undefined {
    if (agentId) {
      return this.agentTools.get(agentId)?.get(name) ?? this.globalTools.get(name);
    }
    return this.globalTools.get(name);
  }

  /**
   * 列出 Agent 可用的所有工具
   *
   * 合并全局工具和 Agent 级工具，Agent 级优先。
   */
  listForAgent(agentId: string): ToolDefinition[] {
    const tools = new Map<string, RegisteredTool>();

    // 先加全局
    for (const [name, tool] of this.globalTools) {
      tools.set(name, tool);
    }

    // 再加 agent 级（覆盖同名全局）
    const agentMap = this.agentTools.get(agentId);
    if (agentMap) {
      for (const [name, tool] of agentMap) {
        tools.set(name, tool);
      }
    }

    return Array.from(tools.values()).map((t) => t.definition);
  }

  /**
   * 获取 LLM 可理解的 tool 定义（OpenAI function calling 格式）
   *
   * 转换为：
   * ```json
   * {
   *   "type": "function",
   *   "function": {
   *     "name": "tool_name",
   *     "description": "Tool description",
   *     "parameters": {
   *       "type": "object",
   *       "properties": { ... },
   *       "required": [...]
   *     }
   *   }
   * }
   * ```
   */
  getDefinitionsForLLM(agentId: string): unknown[] {
    return this.listForAgent(agentId).map((definition) => ({
      type: 'function',
      function: {
        name: definition.name,
        description: definition.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(definition.parameters).map(([key, param]) => [
              key,
              {
                type: param.type,
                description: param.description,
                ...(param.enum && { enum: param.enum }),
              },
            ]),
          ),
          required: Object.entries(definition.parameters)
            .filter(([, param]) => param.required)
            .map(([key]) => key),
        },
      },
    }));
  }

  /**
   * 执行工具
   *
   * @param name - 工具名称
   * @param args - 工具参数
   * @param context - 执行上下文
   * @returns 工具执行结果
   * @throws 工具不存在或缺少必填参数时抛出错误
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const tool = this.get(name, context.agentId);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }

    // 参数校验
    this.validateArgs(name, args, tool.definition);

    return tool.handler(args, context);
  }

  /**
   * 校验工具参数
   *
   * 目前只检查必填参数是否提供。
   * TODO: 增加类型校验、枚举校验等。
   */
  private validateArgs(name: string, args: Record<string, unknown>, definition: ToolDefinition): void {
    for (const [key, param] of Object.entries(definition.parameters)) {
      if (param.required && !(key in args)) {
        throw new Error(`Tool "${name}": missing required parameter "${key}"`);
      }
    }
  }
}
