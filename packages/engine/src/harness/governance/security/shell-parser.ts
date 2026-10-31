/**
 * Shell Parser — 解析入口 facade
 *
 * 主引擎：tree-sitter（shell-parser-treesitter.ts，vendored bash 语法 wasm）；
 * 回退引擎：纯字符串解析（shell-parser-fallback.ts，长期保留的降级防线，
 * 保证主引擎缺席/解析报错时硬边界探测仍有输入）。
 * 消费方（risk-evaluator / degradation）只依赖本模块导出，不感知引擎差异。
 *
 * 回退语义：
 * - 引擎未初始化（未走 Agent 构建引导的直接调用，如单元测试）→ fallback 结果；
 * - tree-sitter 对某输入解析报错（语法树含 ERROR）或内部异常 → fallback 结果
 *   并标记 `uncertain: true`，风险分档会附加「结构不确定」因子走 unknown 通道。
 */

import type { ParsedCommand } from './risk-types.js';
import { parseShellCommandFallback } from './shell-parser-fallback.js';
import {
  initShellParser,
  isShellParserReady,
  getShellParserEngine,
  parseShellCommandWithTreeSitter,
} from './shell-parser-treesitter.js';

export { initShellParser, isShellParserReady, getShellParserEngine };
export { parseShellCommandFallback } from './shell-parser-fallback.js';

/**
 * 解析 Shell 命令
 *
 * @param raw - 原始命令字符串
 * @returns 解析结果（parsed: true/false 表示解析是否成功）
 */
export function parseShellCommand(raw: string): ParsedCommand & { parsed: boolean } {
  if (isShellParserReady()) {
    const parsed = parseShellCommandWithTreeSitter(raw);
    if (parsed) return parsed;
    // tree-sitter 无法确定性解析该输入：回退 fallback 并标记不确定，
    // 让风险分档把「解析不确定」显式计入（未知走 unknown 通道，不静默）。
    return { ...parseShellCommandFallback(raw), uncertain: true };
  }
  return parseShellCommandFallback(raw);
}

// ── 导出工具函数 ──

/**
 * 获取所有命令名（不含 wrapper）
 *
 * @param parsed - 解析结果
 * @returns 命令名列表
 */
export function getCommandNames(parsed: ParsedCommand): string[] {
  return parsed.segments.map(s => s.command);
}

/**
 * 获取所有重定向目标路径（含未挂载到命令段的孤立重定向）
 *
 * @param parsed - 解析结果
 * @returns 重定向目标列表
 */
export function getRedirectTargets(parsed: ParsedCommand): string[] {
  return [
    ...parsed.segments.flatMap(s => s.redirects.map(r => r.target)),
    ...(parsed.orphanRedirects ?? []).map(r => r.target),
  ];
}

/**
 * 判断命令是否包含指定的命令名
 *
 * @param parsed - 解析结果
 * @param command - 命令名
 * @returns 是否包含
 */
export function hasCommand(parsed: ParsedCommand, command: string): boolean {
  return parsed.segments.some(s => s.command === command);
}
