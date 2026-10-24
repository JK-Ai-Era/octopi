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
