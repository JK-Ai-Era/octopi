/**
 * 未知配置键检测 — 防 Zod strip 静默吞 typo（P3，arch/config-hot-reload.md §7）
 *
 * Zod 默认 strip 未知键：`{"mod": "host"}` 这类 typo 会被静默丢弃，用户以为保存了。
 * 本模块对比 raw 路径树与校验输出路径树，找出被丢弃的键。写路径拒绝（fail-loud），
 * 启动路径仅告警（存量配置兼容）。
 *
 * @module
 */
import { OctopiConfigSchema } from './index.js';

/** 合法过时键（迁移消费，不算 typo；与 loadConfig 的 warn-only 迁移语义一致） */
const LEGACY_KEYS = new Set(['budget', 'supervisor', 'distributedIntelligence']);

/** 合法元数据键（JSON Schema 关联等，VSCode 等工具写入，运行时本就忽略但绝非 typo） */
const METADATA_KEYS = new Set(['$schema']);

/**
 * 递归对比 raw 与 parsed 的键树，收集被 strip 的路径
 *
 * @param rawVal - raw 值
 * @param parsedVal - 校验输出对应值
 * @param path - 当前路径前缀
 * @param out - 收集器
 */
function collectStripped(rawVal: unknown, parsedVal: unknown, path: string, out: string[]): void {
  if (Array.isArray(rawVal)) {
    rawVal.forEach((item, i) => {
      collectStripped(item, Array.isArray(parsedVal) ? parsedVal[i] : undefined, `${path}[${i}]`, out);
    });
    return;
  }
  if (rawVal !== null && typeof rawVal === 'object') {
    const parsedObj =
      parsedVal !== null && typeof parsedVal === 'object' && !Array.isArray(parsedVal)
        ? (parsedVal as Record<string, unknown>)
        : {};
    for (const [key, value] of Object.entries(rawVal as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in parsedObj)) {
        out.push(childPath);
        continue;
      }
      collectStripped(value, parsedObj[key], childPath, out);
    }
  }
}

/**
 * 检测会被 schema 静默丢弃（strip）的未知配置键
 *
 * 对比前剔除合法 legacy 键（#2：`budget` 等由迁移消费，不算 typo——否则 P3 前的
 * 备份全部无法回滚）。注意与 loadConfig 的 warn-only 迁移语义一致，不重写内容。
 *
 * @param raw - raw 配置对象
 * @returns 被丢弃的键路径数组；校验本身失败时返回空数组（错误由校验层报）
 */
export function detectUnknownConfigKeys(raw: unknown): string[] {
  const parsed = OctopiConfigSchema.safeParse(raw);
  if (!parsed.success) return [];
  const unknown: string[] = [];
  collectStripped(raw, parsed.data, '', unknown);
  return unknown.filter((path) => {
    const topLevel = path.split('.')[0]!.split('[')[0]!;
    return !LEGACY_KEYS.has(topLevel) && !METADATA_KEYS.has(topLevel);
  });
}

/**
 * 断言无未知配置键（显式校验场景用；配置写回路径已降级为告警，见方案3）
 *
 * @param raw - raw 配置对象
 * @throws 存在被丢弃的键时抛错（列出全部路径）
 */
export function assertNoUnknownConfigKeys(raw: unknown): void {
  const unknown = detectUnknownConfigKeys(raw);
  if (unknown.length > 0) {
    throw new Error(
      `unknown config key(s), would be silently discarded: ${unknown.join(', ')} — fix the typo or remove the key`,
    );
  }
}

/**
 * 配置路径字符串 → 路径段数组（deleteJsonPath 用）
 *
 * 形如 `security.preset`、`agents[0].effctPolicy`、`models.providers.openai.x`。
 *
 * @param path - detectUnknownConfigKeys 输出的路径
 * @returns 路径段（对象键字符串 / 数组下标数字）
 */
export function parseConfigPath(path: string): Array<string | number> {
  const segments: Array<string | number> = [];
  for (const part of path.split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) throw new Error(`invalid config path: ${path}`);
    if (m[1]) segments.push(m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) {
      segments.push(Number(idx[1]));
    }
  }
  return segments;
}
