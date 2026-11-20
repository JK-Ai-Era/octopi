/**
 * 控制台准入密钥（`channels[type=http].apiKey`）读取原语 —— CLI 与 Web 向导共用。
 *
 * 背景：`initOctopi` 脚手架会生成随机 apiKey（B-1 拍板 secure-by-default）。它只锁在
 * 配置文件里，用户无从知晓，很多人也不知道该去哪里找——向导收尾必须把它亮出来。
 *
 * **两种 apiKey 不可混淆**（这是本模块存在的唯一理由）：
 * - `channels[type=http].apiKey` = **控制台准入密钥**，本模块读取、可以回显给用户。
 * - `choices.apiKey` / `models.providers[].apiKey` = **LLM provider 密钥**，绝不回显。
 * 两者的删除/回显口径完全不同，混用会把上游模型密钥泄漏到浏览器。
 *
 * 生效值必须按 daemon 同源口径展开 `${VAR}`（`loadConfig` 用 `expandEnvPlaceholders`）：
 * 直接粘字面占位符进登录页必然失败。解析不出时返回「指向变量名」而不返回假钥。
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { expandEnvPlaceholders } from './env.js';

/**
 * 控制台准入密钥的判定结果。
 *
 * - `key`：已拿到可直接粘贴进登录页的生效值
 * - `env-ref`：配置是 `${VAR}` 引用且当前环境解析不出——只能告知变量名
 * - `none`：配置未设 apiKey（无鉴权模式）
 * - `unreadable`：配置缺失/损坏，无从判定
 */
export type ConsoleAccessKey =
  | { kind: 'key'; value: string; source: string }
  | { kind: 'env-ref'; ref: string }
  | { kind: 'none' }
  | { kind: 'unreadable' };

/** 配置文件里 `channels[type=http]` 的形状（只取本模块关心的字段） */
interface ChannelsShape {
  channels?: Array<{ type?: unknown; apiKey?: unknown }>;
}

/**
 * 读取控制台的准入密钥（`channels[type=http].apiKey`），按 daemon 口径展开 `${VAR}`。
 *
 * 只读、不写、不缓存——向导收尾时调用一次即可。配置损坏不抛错：返回 `unreadable`
 * 让调用方明说「读不到」，而不是谎报一个不存在的密钥。
 *
 * @param configPath - 配置文件路径（`octopi.json`）
 * @returns 判定结果（四态；调用方按 kind 分支文案，不假设一定有钥）
 */
export function readConsoleAccessKey(configPath: string): ConsoleAccessKey {
  let raw: ChannelsShape | undefined;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as ChannelsShape;
  } catch {
    // 仅「文件缺失/不可读/非 JSON」可达：首启时配置可能尚未脚手架，损坏配置也无从读钥
    return { kind: 'unreadable' };
  }
  const http = raw?.channels?.find((c) => c?.type === 'http');
  const rawKey = typeof http?.apiKey === 'string' && http.apiKey ? http.apiKey : undefined;
  if (!rawKey) return { kind: 'none' };
  const value = expandEnvPlaceholders(rawKey);
  // 展开后仍含 `${` = 变量未设置且无默认值（expandEnvPlaceholders 对无默认值返回空串，
  // 故真正兜底的是空值判断；保留占位符判断以覆盖 `${}` 嵌套等异常形态）
  if (!value || value.includes('${')) return { kind: 'env-ref', ref: rawKey };
  return { kind: 'key', value, source: rawKey };
}
