/**
 * DefaultToolBus — ToolBus 接口的 Harness 层实现
 *
 * 统一的工具注册、发现、策略过滤、格式转换入口。
 * 替代原先散落在 ToolRegistry / ToolSet / Builder 中的工具管理逻辑。
 *
 * 职责：
 * - 管理全局和 agent 级工具注册
 * - 按 ToolPolicy（allow/deny）过滤
 * - RegisteredTool → LLM function calling 格式转换
 * - 工具参数校验
 *
 * 不负责：
 * - 工具执行（由 agentLoop + beforeToolCall 回调链负责）
 * - 安全检查（由 SecurityGuard + beforeToolCall 负责）
 *
 * @module harness/plugin-ecosystem/tools/tool-bus
 */

import type {
  RegisteredTool,
  ToolDefinition,
  ToolParameter,
  ToolPolicy,
} from '../../../core/types.js';
import type { ToolBus } from '../../../core/interfaces/tool-bus.js';

/**
 * DefaultToolBus — 工具总线实现
 *
 * 内部按两层管理工具：
 * - globalTools: 全局工具（所有 agent 共享）
 * - agentTools: Agent 级工具（按 agentId 隔离，覆盖同名全局工具）
 */
export class DefaultToolBus implements ToolBus {
  private globalTools = new Map<string, RegisteredTool>();
  private agentTools = new Map<string, Map<string, RegisteredTool>>();

  // ── 注册 ──

  register(tool: RegisteredTool): void {
    const { name } = tool.definition;
    if (this.globalTools.has(name)) {
      throw new Error(`Global tool "${name}" already registered`);
    }
    this.globalTools.set(name, tool);
  }

  registerAll(tools: RegisteredTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  registerForAgent(agentId: string, tool: RegisteredTool): void {
    if (!this.agentTools.has(agentId)) {
      this.agentTools.set(agentId, new Map());
    }
    this.agentTools.get(agentId)!.set(tool.definition.name, tool);
  }

  unregister(name: string, agentId?: string): boolean {
    if (agentId) {
      return this.agentTools.get(agentId)?.delete(name) ?? false;
    }
    return this.globalTools.delete(name);
  }

  // ── 查询 ──

  getTool(name: string, agentId?: string): RegisteredTool | undefined {
    if (agentId) {
      return this.agentTools.get(agentId)?.get(name) ?? this.globalTools.get(name);
    }
    return this.globalTools.get(name);
  }

  listForAgent(agentId: string): RegisteredTool[] {
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

    return Array.from(tools.values());
  }

  // ── 解析 ──

  resolve(agentId: string, policy?: ToolPolicy): RegisteredTool[] {
    let tools = this.listForAgent(agentId);

    if (policy) {
      if (policy.allow && policy.allow.length > 0) {
        const allowSet = new Set(policy.allow);
        tools = tools.filter(t => allowSet.has(t.definition.name));
      }
      if (policy.deny && policy.deny.length > 0) {
        const denySet = new Set(policy.deny);
        tools = tools.filter(t => !denySet.has(t.definition.name));
      }
    }

    return tools;
  }

  toLLMDefinitions(agentId: string, policy?: ToolPolicy): unknown[] {
    return this.resolve(agentId, policy).map(definition => ({
      type: 'function',
      function: {
        name: definition.definition.name,
        description: definition.definition.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(definition.definition.parameters).map(([key, param]) => [
              key,
              {
                type: param.type,
                description: param.description,
                ...(param.enum && { enum: param.enum }),
              },
            ]),
          ),
          required: Object.entries(definition.definition.parameters)
            .filter(([, param]) => param.required)
            .map(([key]) => key),
        },
      },
    }));
  }

  /**
   * 校验工具参数
   *
   * 包括必填、类型、枚举、范围、长度、正则、嵌套对象和数组。
   * 校验失败时抛出异常。
   */
  validateArgs(name: string, args: Record<string, unknown>, definition: ToolDefinition): void {
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


  /**
   * 执行工具（便捷方法）
   *
   * 查找工具 → 参数校验 → 调用 handler。
   * 适用于在 agentLoop 外部直接调用工具的场景。
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: import('../../../core/types.js').ToolExecutionContext,
  ): Promise<unknown> {
    const tool = this.getTool(name, context.agentId);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }
    this.validateArgs(name, args, tool.definition);
    return tool.handler(args, context);
  }
  /**
   * 获取全局注册的工具名集合（用于 SecurityGuard 的 registeredTools 校验）
   */
  getGlobalToolNames(): Set<string> {
    return new Set(this.globalTools.keys());
  }

  // ── 参数校验（内部） ──

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
    if (!param.enum || param.enum.length === 0) return;
    const normalize = (v: unknown) => (typeof v === 'string' ? v.trim() : v);
    const allowed = new Set(param.enum.map(v => normalize(v)));
    if (!allowed.has(normalize(value))) {
      throw new Error(`Tool "${name}": parameter "${key}" must be one of ${JSON.stringify(param.enum)}, received ${JSON.stringify(value)}`);
    }
  }

  private validateRange(name: string, key: string, value: unknown, param: ToolParameter): void {
    if (param.type !== 'number' || typeof value !== 'number') return;
    if (param.minimum !== undefined && value < param.minimum) {
      throw new Error(`Tool "${name}": parameter "${key}" must be >= ${param.minimum}, received ${value}`);
    }
    if (param.maximum !== undefined && value > param.maximum) {
      throw new Error(`Tool "${name}": parameter "${key}" must be <= ${param.maximum}, received ${value}`);
    }
  }

  private validateLength(name: string, key: string, value: unknown, param: ToolParameter): void {
    if (param.type !== 'string' || typeof value !== 'string') return;
    if (param.minLength !== undefined && value.length < param.minLength) {
      throw new Error(`Tool "${name}": parameter "${key}" length must be >= ${param.minLength}, received ${value.length}`);
    }
    if (param.maxLength !== undefined && value.length > param.maxLength) {
      throw new Error(`Tool "${name}": parameter "${key}" length must be <= ${param.maxLength}, received ${value.length}`);
    }
  }

  private validatePattern(name: string, key: string, value: unknown, param: ToolParameter): void {
    if (!param.pattern || typeof value !== 'string') return;
    const regex = new RegExp(param.pattern);
    if (!regex.test(value)) {
      throw new Error(`Tool "${name}": parameter "${key}" must match pattern ${param.pattern}`);
    }
  }

  private validateArray(name: string, key: string, value: unknown, param: ToolParameter): void {
    if (param.type !== 'array' || !Array.isArray(value)) return;
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
    if (param.type !== 'object' || typeof value !== 'object' || Array.isArray(value) || value === null) return;
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
