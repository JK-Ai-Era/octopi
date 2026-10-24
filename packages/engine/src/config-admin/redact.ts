/**
 * 配置脱敏 — WebUI 回显形态（arch/config-hot-reload.md §0）
 *
 * apiKey 只回显「是否已配置 + 引用形态」，绝不回显明文值。
 * `${VAR}` 形态给变量名；明文形态只标记 `literal`。
 *
 * @module
 */

/** 脱敏后的密钥视图 */
export interface RedactedSecret {
  /** 是否已配置非空值 */
  configured: boolean;
  /** `${VAR}` 形态 → 变量名；明文 → `'literal'`；未配置 → null */
  ref: string | null;
}

/** 脱敏后的 provider 视图（WebUI 表单回显） */
export interface RedactedProvider {
  name: string;
  baseUrl: string;
  api: string;
  models: Array<Record<string, unknown>>;
  timeoutSeconds?: number;
  apiKey: RedactedSecret;
}

const ENV_REF_PATTERN = /^\$\{(\w+)(?::-.*?)?\}$/;

/**
 * 把 apiKey 字符串脱敏为 `RedactedSecret`
 *
 * @param value - 原始 apiKey（可能为 `${VAR}` 形态、明文或空）
 * @returns 脱敏视图（不含明文）
 */
export function redactSecret(value: string | undefined): RedactedSecret {
  if (!value) return { configured: false, ref: null };
  const m = ENV_REF_PATTERN.exec(value);
  if (m) return { configured: true, ref: m[1] };
  return { configured: true, ref: 'literal' };
}

/**
 * 脱敏单个 provider 配置
 *
 * @param name - provider 名
 * @param pc - provider 配置（已展开 `${ENV}` 的运行时形态或 raw 形态均可）
 * @returns 脱敏视图
 */
export function redactProvider(name: string, pc: Record<string, unknown>): RedactedProvider {
  const out: RedactedProvider = {
    name,
    baseUrl: typeof pc.baseUrl === 'string' ? pc.baseUrl : '',
    api: typeof pc.api === 'string' ? pc.api : '',
    models: Array.isArray(pc.models) ? (pc.models as Array<Record<string, unknown>>) : [],
    apiKey: redactSecret(typeof pc.apiKey === 'string' ? pc.apiKey : undefined),
  };
  if (typeof pc.timeoutSeconds === 'number') out.timeoutSeconds = pc.timeoutSeconds;
  return out;
}
