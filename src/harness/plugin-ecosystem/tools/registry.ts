/**
 * 工具注册中心
 *
 * 管理所有已注册的工具，支持：
 * - 全局工具和 Agent 级工具（Agent 级覆盖同名全局工具）
 * - 工具策略（白名单/黑名单/确认机制）
 * - LLM function calling 格式转换
 * - 参数校验（类型、必填、枚举、范围、长度、正则）
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

import type { RegisteredTool, ToolDefinition, ToolExecutionContext, ToolParameter } from '../../../core/types.js';

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
   * @throws 工具不存在或参数校验失败时抛出错误
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
   * 校验工具参数，包括必填、类型、枚举、范围、长度和正则。
   *
   * 当参数命中明确错误时抛出异常，避免把非法输入下发到 handler。
   */
  private validateArgs(name: string, args: Record<string, unknown>, definition: ToolDefinition): void {
    for (const [key, param] of Object.entries(definition.parameters)) {
      if (!(key in args)) {
        if (param.required) {
          throw new Error(`Tool "${name}": missing required parameter "${key}"`);
        }
        continue;
      }

      const value = args[key];
      this.validateType(name, key, value, param);
      this.validateEnum(name, key, value, param);
      this.validateRange(name, key, value, param);
      this.validateLength(name, key, value, param);
      this.validatePattern(name, key, value, param);
      this.validateArray(name, key, value, param);
      this.validateObject(name, key, value, param);
    }
  }

  private validateType(name: string, key: string, value: unknown, param: ToolParameter): void {
    if (value === null || value === undefined) {
      throw new Error(`Tool "${name}": parameter "${key}" must be ${param.type}, received nullish`);
    }

    const ok = ((t: string, v: unknown): boolean => {
      switch (t) {
        case 'string': return typeof v === 'string';
        case 'number': return typeof v === 'number' && Number.isFinite(v);
        case 'boolean': return typeof v === 'boolean';
        case 'object': return typeof v === 'object';
        case 'array': return Array.isArray(v);
        default: return true;
      }
    })(param.type, value);

    if (!ok) {
      throw new Error(`Tool "${name}": parameter "${key}" must be ${param.type}, received ${typeof value}`);
    }
  }

  private validateEnum(name: string, key: string, value: unknown, param: ToolParameter): void {
    if (!param.enum || param.enum.length === 0) {
      return;
    }

    const normalize = (v: unknown) => (typeof v === 'string' ? v.trim() : v);
    const allowed = new Set(param.enum.map((v) => normalize(v)));
    if (!allowed.has(normalize(value))) {
      throw new Error(`Tool "${name}": parameter "${key}" must be one of ${JSON.stringify(param.enum)}, received ${JSON.stringify(value)}`);
    }
  }

  private validateRange(name: string, key: string, value: unknown, param: ToolParameter): void {
    if (param.type !== 'number' || typeof value !== 'number') {
      return;
    }

    if (param.minimum !== undefined && value < param.minimum) {
      throw new Error(`Tool "${name}": parameter "${key}" must be >= ${param.minimum}, received ${value}`);
    }
    if (param.maximum !== undefined && value > param.maximum) {
      throw new Error(`Tool "${name}": parameter "${key}" must be <= ${param.maximum}, received ${value}`);
    }
  }

  private validateLength(name: string, key: string, value: unknown, param: ToolParameter): void {
    if (param.type !== 'string' || typeof value !== 'string') {
      return;
    }

    if (param.minLength !== undefined && value.length < param.minLength) {
      throw new Error(`Tool "${name}": parameter "${key}" length must be >= ${param.minLength}, received ${value.length}`);
    }
    if (param.maxLength !== undefined && value.length > param.maxLength) {
      throw new Error(`Tool "${name}": parameter "${key}" length must be <= ${param.maxLength}, received ${value.length}`);
    }
  }

  private validatePattern(name: string, key: string, value: unknown, param: ToolParameter): void {
    if (!param.pattern || typeof value !== 'string') {
      return;
    }

    const regex = new RegExp(param.pattern);
    if (!regex.test(value)) {
      throw new Error(`Tool "${name}": parameter "${key}" must match pattern ${param.pattern}`);
    }
  }

  private validateArray(name: string, key: string, value: unknown, param: ToolParameter): void {
    if (param.type !== 'array' || !Array.isArray(value)) {
      return;
    }

    if (param.items) {
      for (const item of value) {
        this.validateType(name, `${key}[]`, item, param.items);
        this.validateEnum(name, `${key}[]`, item, param.items);
        this.validateRange(name, `${key}[]`, item, param.items);
        this.validateLength(name, `${key}[]`, item, param.items);
        this.validatePattern(name, `${key}[]`, item, param.items);
        this.validateArray(name, `${key}[]`, item, param.items);
        this.validateObject(name, `${key}[]`, item, param.items);
      }
    }

    if (param.minItems !== undefined && value.length < param.minItems) {
      throw new Error(`Tool "${name}": parameter "${key}" must have >= ${param.minItems} items, received ${value.length}`);
    }
    if (param.maxItems !== undefined && value.length > param.maxItems) {
      throw new Error(`Tool "${name}": parameter "${key}" must have <= ${param.maxItems} items, received ${value.length}`);
    }
  }

  private validateObject(name: string, key: string, value: unknown, param: ToolParameter): void {
    if (param.type !== 'object' || typeof value !== 'object' || Array.isArray(value) || value === null) {
      return;
    }

    if (param.properties) {
      const record = value as Record<string, unknown>;
      for (const [nestedKey, nestedParam] of Object.entries(param.properties)) {
        const nestedValue = record[nestedKey];
        if (nestedValue === undefined) {
          if (nestedParam.required) {
            throw new Error(`Tool "${name}": nested parameter "${key}.${nestedKey}" is required`);
          }
          continue;
        }
        this.validateType(name, `${key}.${nestedKey}`, nestedValue, nestedParam);
        this.validateEnum(name, `${key}.${nestedKey}`, nestedValue, nestedParam);
        this.validateRange(name, `${key}.${nestedKey}`, nestedValue, nestedParam);
        this.validateLength(name, `${key}.${nestedKey}`, nestedValue, nestedParam);
        this.validatePattern(name, `${key}.${nestedKey}`, nestedValue, nestedParam);
        this.validateArray(name, `${key}.${nestedKey}`, nestedValue, nestedParam);
        this.validateObject(name, `${key}.${nestedKey}`, nestedValue, nestedParam);
      }
    }
  }
}
