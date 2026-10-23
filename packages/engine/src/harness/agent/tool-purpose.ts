/**
 * Tool Call purpose — 统一 schema 装配（arch/tool-call-purpose.md）
 *
 * 注入点唯一：RegisteredTool → LLM/AgentTool parameters 必须经此模块，
 * 禁止 builder / gateway / tool-bus 各自拼一套（否则模型看到的 required 不一致）。
 */
import type { ToolDefinition, ToolParameter } from '@octopi-agent/core/types.js';

/**
 * 统一注入的行动简述参数。
 *
 * description 只留极短 stub（schema 自解释兜底）；详版+示例在 TOOL_PURPOSE_SYSTEM_NOTE
 * 全局说明（system prompt 稳定块）只写一次——55 个工具不再重复同一段 157 字符文案
 * （方案 S，arch/tool-call-purpose.md「演进」）。
 */
export const TOOL_PURPOSE_PARAM = {
  type: 'string' as const,
  description: 'Call purpose: what + why, ≤120 chars',
};

/** purpose 填法的全局说明（详版与示例唯一来源；system prompt 稳定块，缓存无损） */
export const TOOL_PURPOSE_SYSTEM_NOTE = `### Tool call purpose
Every tool call MUST include a \`purpose\` argument: one short honest line for humans and approvers — what the call does and why (verb + object + goal, max 120 chars). Example: "overwrite src/a.ts to fix timeout". Never leave it empty.`;

/** 仅保留 OpenAI function calling 可识别的 JSON Schema 关键字 */
export function sanitizeToolJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeToolJsonSchema);
  if (!node || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof src.type === 'string') out.type = src.type;
  if (typeof src.description === 'string') out.description = src.description;
  if (Array.isArray(src.enum)) out.enum = src.enum;
  if (src.properties && typeof src.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src.properties as Record<string, unknown>)) {
      props[k] = sanitizeToolJsonSchema(v);
    }
    out.properties = props;
  }
  if (Array.isArray(src.required)) out.required = src.required.filter((x) => typeof x === 'string');
  if (src.items !== undefined) out.items = sanitizeToolJsonSchema(src.items);
  return out;
}

/**
 * RegisteredTool 参数面 → LLM JSON Schema，并统一注入 purpose。
 *
 * - purpose 始终存在且 required 一次（工具自带 purpose 时同名同义覆盖，不得重复 required）
 * - purpose 放在 properties 首位，降低模型漏填
 * - 其余字段只保留 wire 关键字
 */
export function buildToolLlmParameters(
  parameters: Record<string, ToolParameter> | undefined,
): Record<string, unknown> {
  const own = parameters ?? {};
  // purpose 置首：部分模型只扫 schema 开头的必填项
  const props: Record<string, unknown> = {
    purpose: { ...TOOL_PURPOSE_PARAM },
  };
  for (const [key, param] of Object.entries(own)) {
    if (key === 'purpose') continue;
    props[key] = {
      type: param.type,
      description: param.description,
      ...(param.enum && { enum: param.enum }),
      ...(param.properties && { properties: param.properties }),
      ...(param.items && { items: param.items }),
      ...(param.required && { required: param.required }),
    };
  }

  const required: string[] = ['purpose'];
  for (const [key, param] of Object.entries(own)) {
    if (key === 'purpose') continue;
    if (param.required && !required.includes(key)) required.push(key);
  }

  return sanitizeToolJsonSchema({
    type: 'object',
    properties: props,
    required,
  }) as Record<string, unknown>;
}

/** 工具定义是否把 purpose 声明为业务入参（如 photo_capture 同意理由） */
export function toolDeclaresPurpose(definition: ToolDefinition): boolean {
  return Object.prototype.hasOwnProperty.call(definition.parameters ?? {}, 'purpose');
}

/** 从 tool call args 读取 purpose（缺省/空串 → ''） */
export function readToolCallPurpose(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const purpose = (args as Record<string, unknown>).purpose;
  return typeof purpose === 'string' ? purpose.trim() : '';
}

/**
 * 解析本次调用的 purpose。
 *
 * schema 已标 required，但部分模型仍会漏填。purpose 只作人读/审批标题，
 * 漏填时从工具名 + 关键参数推导一条，保证调用可执行且 UI 仍有标题；
 * 不因此中断业务（否则 web_search 等会整批 purpose_required）。
 */
export function resolveToolCallPurpose(toolName: string, args: unknown): string {
  const explicit = readToolCallPurpose(args);
  if (explicit) return explicit;
  return deriveFallbackPurpose(toolName, args);
}

function deriveFallbackPurpose(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object') return `call ${toolName}`;
  const record = args as Record<string, unknown>;
  const hints: string[] = [];
  for (const key of ['query', 'path', 'command', 'url', 'question', 'description', 'text', 'content', 'goal_id', 'task_id', 'session_id', 'chunk_id']) {
    const v = record[key];
    if (typeof v === 'string' && v.trim()) {
      hints.push(v.trim().replace(/\s+/g, ' ').slice(0, 80));
      break;
    }
  }
  return hints.length > 0 ? `${toolName}: ${hints[0]}` : `call ${toolName}`;
}

/**
 * 进 handler 的 args：注入型 purpose 剥离；工具自带 purpose 保留（device 同意/审计需要）。
 */
export function prepareHandlerArgs(
  args: Record<string, unknown>,
  definition: ToolDefinition,
): Record<string, unknown> {
  if (toolDeclaresPurpose(definition)) return { ...args };
  const handlerArgs = { ...args };
  delete handlerArgs.purpose;
  return handlerArgs;
}
