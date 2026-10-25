/**
 * `${ENV}` 占位符展开 — 根包 loadConfig/FileConfigService 与 gateway 热应用共用
 * （唯一实现点；gateway 不能 import 根包，故置 engine）
 *
 * @module
 */

const ENV_PATTERN = /\$\{(\w+)(?::-(.*?))?\}/g;

/**
 * 展开文本中的 `${ENV_VAR}` / `${ENV_VAR:-default}` 占位符
 *
 * @param text - 含占位符的文本（或整份配置原文）
 * @returns 展开后的文本；未设置且无默认值 → 空串（apiKey 等字段由校验兜底）
 */
export function expandEnvPlaceholders(text: string): string {
  return text.replace(ENV_PATTERN, (_, key, defaultVal) => {
    const val = process.env[key];
    if (val !== undefined) return val;
    if (defaultVal !== undefined) return defaultVal;
    return '';
  });
}

/**
 * 递归展开对象/数组内所有字符串值的 `${ENV}`（blocker 修复：热应用路径的 provider
 * 配置必须用展开形态——`createProviderFromConfig` 不做展开，raw 字面量会直接进
 * Authorization 头。盘上写回仍保持 raw 占位符形态，仅运行时实例用本函数。）
 *
 * @param value - 任意配置值
 * @returns 展开后的副本（原对象不被修改）
 */
export function expandEnvValues<T>(value: T): T {
  if (typeof value === 'string') return expandEnvPlaceholders(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => expandEnvValues(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expandEnvValues(v)]),
    ) as unknown as T;
  }
  return value;
}
