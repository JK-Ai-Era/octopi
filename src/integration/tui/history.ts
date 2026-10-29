/**
 * TUI 会话历史转换（纯函数）。
 *
 * 把 Gateway 的 Message[] 转成 ChatLog 可渲染的条目，并提供
 * 会话列表格式化 / 会话选择解析。无 IO、无 UI 依赖——单测直接钉行为。
 */

import type { Message, ContentBlock } from '@octopi-agent/core/types/messages.js';
import type { SessionMeta } from '@octopi-agent/core/types/session.js';

// ── Chat 条目（ChatLog 渲染输入） ──

export type ChatEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; args: string; result: string; isError: boolean }
  | { kind: 'system'; text: string };

/** 内容块 → 纯文本（非文本块降级为占位标注，终端不渲染媒体本体） */
export function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'image') return `[image${block.alt ? `: ${block.alt}` : ''}]`;
      if (block.type === 'file') return `[file${block.name ? `: ${block.name}` : ''}]`;
      return `[${block.type}]`;
    })
    .join('\n');
}

/**
 * 历史消息 → 渲染条目。
 *
 * - user / assistant 正文各成一条；assistant 的 toolCalls 逐个渲染为 tool 条目；
 * - role=tool 的消息取 toolResults 渲染（无 toolResults 时以正文兜底）；
 * - system 正文降级为 system 条目。
 *
 * @param messages - Gateway 历史页消息（含 index）
 * @returns 渲染条目序列（顺序与输入一致）
 */
export function toChatEntries(messages: Array<Message & { index: number }>): ChatEntry[] {
  const entries: ChatEntry[] = [];
  for (const msg of messages) {
    const text = contentToText(msg.content);
    switch (msg.role) {
      case 'user':
        entries.push({ kind: 'user', text });
        break;
      case 'assistant': {
        if (text) entries.push({ kind: 'assistant', text });
        for (const call of msg.toolCalls ?? []) {
          entries.push({
            kind: 'tool',
            name: call.name,
            args: formatArgs(call.arguments),
            result: '',
            isError: false,
          });
        }
        break;
      }
      case 'tool': {
        const results = msg.toolResults ?? [];
        if (results.length > 0) {
          for (const r of results) {
            entries.push({
              kind: 'tool',
              name: r.name,
              args: '',
              result: typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? ''),
              isError: Boolean(r.error),
            });
          }
        } else if (text) {
          entries.push({ kind: 'tool', name: 'tool', args: '', result: text, isError: false });
        }
        break;
      }
      case 'system':
        if (text) entries.push({ kind: 'system', text });
        break;
    }
  }
  return entries;
}

function formatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

// ── 会话列表 ──

/** 时间戳 → 紧凑相对时间（如 3m / 2h / 5d；未来时间记 0m） */
export function formatRelativeTime(ts: number, now: number): string {
  const delta = Math.max(0, now - ts);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return '0m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * 会话列表 → 展示行（含序号、当前/运行标记、标题、时间）。
 *
 * @param sessions - listSessions 结果（顺序即展示顺序）
 * @param options - currentId 当前续接会话；now 时间基准
 * @returns 每会话一行
 */
export function formatSessionList(
  sessions: Array<SessionMeta & { running: boolean }>,
  options: { currentId?: string; now: number },
): string[] {
  return sessions.map((s, i) => {
    const marks = [s.id === options.currentId ? '→' : ' ', s.running ? '🏃' : ' '].join('');
    const title = s.title?.trim() || s.id;
    return `${String(i + 1).padStart(3)}. ${marks} ${title}  [${formatRelativeTime(s.updatedAt, options.now)}]`;
  });
}

/**
 * 按 `/resume` 参数解析目标会话：序号（1 起）或会话 id。
 *
 * @param sessions - listSessions 结果
 * @param arg - 用户参数（序号或 id）
 * @returns 命中的会话项；无命中返回 undefined
 */
export function pickSession(
  sessions: Array<SessionMeta & { running: boolean }>,
  arg: string,
): (SessionMeta & { running: boolean }) | undefined {
  const trimmed = arg.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const idx = Number(trimmed) - 1;
    return sessions[idx];
  }
  return sessions.find((s) => s.id === trimmed);
}
