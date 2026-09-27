/**
 * `/name args` 解析与名字规范化
 */

export interface ParsedCommand {
  name: string;
  args: string[];
  raw: string;
}

const NAME_RE = /^[a-z][a-z0-9_-]*$/;

/** 规范化命令名：trim → 去前导 `/` → 小写；非法返回 null */
export function normalizeCommandName(input: string): string | null {
  const trimmed = input.trim().replace(/^\/+/, '').toLowerCase();
  if (!NAME_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * 解析对话输入。仅当 trim 后以 `/` 开头且名字合法时返回 ParsedCommand。
 * `//literal` 由调用方作转义（去一层斜杠后当普通消息），此处不吞。
 */
export function parseCommand(message: string): ParsedCommand | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return null;
  // `//...` 是转义字面量，不是命令
  if (trimmed.startsWith('//')) return null;

  const parts = trimmed.split(/\s+/);
  const rawName = parts[0] ?? '';
  const name = normalizeCommandName(rawName);
  if (!name) return null;

  return {
    name,
    args: parts.slice(1),
    raw: trimmed,
  };
}

/** `//path` → `/path`（普通消息）；非转义原样返回 */
export function unescapeLiteralSlash(message: string): string {
  const trimmed = message.trimStart();
  if (trimmed.startsWith('//')) {
    return message.replace(/^\s*\/\//, '/');
  }
  return message;
}
