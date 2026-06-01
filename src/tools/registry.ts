import type { RegisteredTool, ToolDefinition, ToolExecutionContext } from '../core/types.js';

/**
 * 工具注册中心
 *
 * 支持：
 * - 全局工具和 Agent 级工具
 * - 工具策略（白名单/黑名单）
 * - LLM function calling 格式转换
 */
export class ToolRegistry {
  private globalTools = new Map<string, RegisteredTool>();
  private agentTools = new Map<string, Map<string, RegisteredTool>>();

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

  unregister(name: string, agentId?: string): boolean {
    if (agentId) {
      return this.agentTools.get(agentId)?.delete(name) ?? false;
    }
    return this.globalTools.delete(name);
  }

  get(name: string, agentId?: string): RegisteredTool | undefined {
    if (agentId) {
      return this.agentTools.get(agentId)?.get(name) ?? this.globalTools.get(name);
    }
    return this.globalTools.get(name);
  }

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

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const tool = this.get(name, context.agentId);
    if (!tool) throw new Error(`Tool "${name}" not found`);
    this.validateArgs(name, args, tool.definition);
    return tool.handler(args, context);
  }

  private validateArgs(name: string, args: Record<string, unknown>, definition: ToolDefinition): void {
    for (const [key, param] of Object.entries(definition.parameters)) {
      if (param.required && !(key in args)) {
        throw new Error(`Tool "${name}": missing required parameter "${key}"`);
      }
    }
  }
}
