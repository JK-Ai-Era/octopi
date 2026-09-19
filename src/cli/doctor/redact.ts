/**
 * doctor 输出脱敏：报告/JSON 中不得出现明文密钥
 *
 * @module
 */

const SENSITIVE_KEY_RE = /api[-_]?key|token|password|secret|authorization|credential|private[-_]?key/i;

/** 仅用于报告展示：占位符原样，字面量打码 */
export function redactSecretString(value: string): string {
  if (value.startsWith('${') && value.endsWith('}')) return value;
  if (value.length <= 4) return '***';
  return `${value.slice(0, 3)}***`;
}

/**
 * 深度脱敏配置对象（报告用；不修改原对象）
 *
 * @param value - 任意 JSON 值
 * @returns 可安全打印的副本
 */
export function redactConfig(value: unknown): unknown {
  return redactValue('', value);
}

function redactValue(key: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(key, item));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v);
    }
    return out;
  }
  if (typeof value === 'string' && SENSITIVE_KEY_RE.test(key)) {
    return redactSecretString(value);
  }
  return value;
}

/**
 * 判断字符串是否可能是敏感值（供 finding 文案二次清洗）
 *
 * @param text - 任意文案
 * @returns 是否含疑似密钥模式
 */
export function looksLikeSecret(text: string): boolean {
  return /sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{10,}/.test(text);
}
