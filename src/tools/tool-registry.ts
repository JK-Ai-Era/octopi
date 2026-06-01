import type { RegisteredTool, ToolDefinition, ToolHandler, ToolExecutionContext } from '../core/types.js';

/**
 * 工具注册中心
 *
 * 职责：
 * - 注册/注销工具
 * - 校验工具调用参数
 * - 执行工具
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    const { name } = tool.definition;
    if (this.tools.has(name)) {
      throw new Error(`Tool "${name}" already registered`);
    }
    this.tools.set(name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /**
   * 获取 LLM 可理解的 tool 定义（OpenAI function calling 格式）
   */
  getDefinitionsForLLM(): unknown[] {
    return Array.from(this.tools.values()).map(({ definition }) => ({
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
   * 执行工具调用
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }

    // 基础参数校验
    this.validateArgs(name, args, tool.definition);

    // 执行
    return tool.handler(args, context);
  }

  private validateArgs(
    name: string,
    args: Record<string, unknown>,
    definition: ToolDefinition,
  ): void {
    for (const [key, param] of Object.entries(definition.parameters)) {
      if (param.required && !(key in args)) {
        throw new Error(`Tool "${name}": missing required parameter "${key}"`);
      }
    }
  }
}
