/**
 * `${ENV}` 占位符展开 — 根包 loadConfig/FileConfigService 与 gateway 热应用共用
 * （唯一实现点；gateway 不能 import 根包，故置 engine）
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENV_PATTERN = /\$\{(\w+)(?::-(.*?))?\}/g;

/**
 * 加载 `OCTOPI_HOME/.env` 进 `process.env`（不覆盖已有变量；文件权限 0600 由写入方保证）。
 *
 * 幂等：文件不存在即跳过（无 .env 是常态）；重复调用无副作用（已存在的键不覆盖）。
 * 时机约束：必须在 `${ENV}` 展开（loadConfig / 热应用）之前调用；
 * 守护进程 fork 的子进程通过继承 `process.env` 获得，无需各自加载。
 *
 * @param octopiHome - OCTOPI_HOME 目录
 * @returns 实际写入的变量名列表（供诊断；未加载返回 []）
 */
export function loadOctopiEnvFile(octopiHome: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(octopiHome, '.env'), 'utf8');
  } catch {
    return []; // 仅「文件不存在/不可读」可达；.env 缺省不部署
  }
  const applied: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // 非 KEY=VALUE 行跳过（.env 语法本就宽容）
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

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
