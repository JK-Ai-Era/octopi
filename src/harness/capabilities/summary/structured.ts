/**
 * structured_json — L0 解析 + L1 轻量契约校验
 *
 * @module harness/capabilities/summary/structured
 */

import type { ContentFieldType, StructuredValidator, SummaryPolicy } from './types.js';

export interface StructuredParseOutcome {
  structured?: unknown;
  structuredError?: string;
}

/**
 * L0：从模型输出宽松取出 JSON
 *
 * @param text - 模型原始输出
 * @returns 解析结果
 */
export function parseLooseJson(text: string): StructuredParseOutcome {
  const trimmed = text.trim();
  if (!trimmed) return { structuredError: 'parse: empty' };

  const direct = tryParse(trimmed);
  if (direct !== undefined) return { structured: direct };

  const startObj = findBalanced(trimmed, '{', '}');
  if (startObj) {
    const v = tryParse(startObj);
    if (v !== undefined) return { structured: v };
  }
  const startArr = findBalanced(trimmed, '[', ']');
  if (startArr) {
    const v = tryParse(startArr);
    if (v !== undefined) return { structured: v };
  }
  return { structuredError: 'parse: no JSON object/array found' };
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function findBalanced(text: string, open: string, close: string): string | null {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf(open, searchFrom);
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    // 该起点括号不平衡：从下一个 open 继续，避免噪声吞掉后续合法 JSON
    searchFrom = start + 1;
  }
  return null;
}

/**
 * L1：fields / fieldTypes 轻量契约校验
 *
 * @param value - 已 parse 的 JSON 值
 * @param policy - 含 fields/fieldTypes/schema 的策略
 * @param validator - 可选 L2 校验器
 * @returns 校验结果；ok 时 structured 为 value
 */
export function validateStructured(
  value: unknown,
  policy: SummaryPolicy,
  validator?: StructuredValidator,
): StructuredParseOutcome {
  if (policy.output !== 'structured_json') {
    return { structured: value };
  }

  if (policy.schema && validator) {
    const r = validator.validate(value, policy.schema);
    if (!r.ok) return { structuredError: `schema: ${r.error ?? 'invalid'}` };
    return { structured: value };
  }

  if (!policy.fields?.length && !policy.fieldTypes) {
    return { structured: value };
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    // 允许 array 根时 fields 不适用
    if (Array.isArray(value) && !policy.fields?.length) return { structured: value };
    return { structuredError: 'contract: root must be object when fields are declared' };
  }

  const obj = value as Record<string, unknown>;
  const missing: string[] = [];
  for (const field of policy.fields ?? []) {
    if (!(field in obj)) missing.push(field);
  }
  if (missing.length > 0) {
    return { structuredError: `contract: missing fields [${missing.join(', ')}]` };
  }

  if (policy.fieldTypes) {
    const bad: string[] = [];
    for (const [key, expected] of Object.entries(policy.fieldTypes)) {
      if (!(key in obj)) continue;
      if (!typeMatches(obj[key], expected)) {
        bad.push(`${key} expected ${expected}`);
      }
    }
    if (bad.length > 0) {
      return { structuredError: `contract: type mismatch (${bad.join('; ')})` };
    }
  }

  return { structured: value };
}

function typeMatches(value: unknown, expected: ContentFieldType): boolean {
  if (expected === 'null') return value === null;
  if (value === null) return false;
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * 组合 L0 + L1/L2
 *
 * @param text - 模型输出
 * @param policy - 策略
 * @param validator - 可选完整 schema 校验
 * @returns structured 或 structuredError
 */
export function extractStructured(
  text: string,
  policy: SummaryPolicy,
  validator?: StructuredValidator,
): StructuredParseOutcome {
  const parsed = parseLooseJson(text);
  if (parsed.structuredError) return parsed;
  return validateStructured(parsed.structured, policy, validator);
}
