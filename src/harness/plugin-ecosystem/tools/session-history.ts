/**
 * session_search / session_read — Information 历史会话检索（只读）。
 *
 * 两阶段：search 出 ref 句柄 → read 开窗。输出走 L1 硬顶。
 * 与 memory_search 分工：命题 vs 原文。
 */

import type { RegisteredTool } from '../../../core/types.js';
import type { SessionHistoryPort } from '../../session-history/index.js';

export interface SessionHistoryToolOptions {
  history: SessionHistoryPort;
  summary?: import('../../capabilities/summary/index.js').ToolSummarySupport;
}

/**
 * 创建历史会话工具集
 *
 * @param options - SessionHistoryPort + 可选 summary
 * @returns session_search / session_read
 */
export function createSessionHistoryTools(options: SessionHistoryToolOptions): RegisteredTool[] {
  return [
    createSessionSearchTool(options),
    createSessionReadTool(options),
  ];
}

export function createSessionSearchTool(options: SessionHistoryToolOptions): RegisteredTool {
  return {
    definition: {
      name: 'session_search',
      description:
        'Search past session conversations (Information layer, not memory propositions). Returns session-grouped hits with snippet + `ref` for session_read. Prefer concrete entities (paths, error strings, names). Default excludes tool I/O and archived cold storage. Use memory_search for distilled conclusions; use this for original wording / what happened.',
      parameters: {
        query: {
          type: 'string',
          description: 'Search query (prefer entities, paths, error text)',
          required: true,
        },
        mode: {
          type: 'string',
          description: 'Match mode (default keyword = all terms as substrings)',
          enum: ['keyword', 'phrase', 'regex'],
        },
        roles: {
          type: 'array',
          description: 'Message roles to search (default user+assistant)',
          items: {
            type: 'string',
            description: 'Message role',
            enum: ['user', 'assistant', 'system', 'tool'],
          },
        },
        include_tool_io: {
          type: 'boolean',
          description: 'Also search tool call args/results (default false)',
        },
        author: {
          type: 'string',
          description: 'Filter by message author vs current agent (ranking, not ACL)',
          enum: ['any', 'self', 'others'],
        },
        session_ids: {
          type: 'array',
          description: 'Restrict to these sessions',
          items: { type: 'string', description: 'sessionId' },
        },
        since: { type: 'number', description: 'Only sessions with updatedAt >= epoch ms' },
        until: { type: 'number', description: 'Only sessions with updatedAt <= epoch ms' },
        group_by: {
          type: 'string',
          description: 'session (default, which conversation) or message',
          enum: ['session', 'message'],
        },
        limit: { type: 'number', description: 'Max sessions (or messages if group_by=message)', minimum: 1, maximum: 50 },
        snippet_chars: { type: 'number', description: 'Snippet length (default 200)', minimum: 40, maximum: 400 },
        include_archived: {
          type: 'boolean',
          description: 'Also search cold archives (default false; slower)',
        },
      },
      timeoutMs: 30_000,
    },
    handler: async (args, context) => {
      const raw = await options.history.search({
        query: String(args.query ?? ''),
        mode: args.mode as 'keyword' | 'phrase' | 'regex' | undefined,
        roles: (args.roles as Array<'user' | 'assistant' | 'system' | 'tool'> | undefined) ?? [
          'user',
          'assistant',
        ],
        includeToolIo: args.include_tool_io === true,
        author: args.author as 'any' | 'self' | 'others' | undefined,
        agentId: context.agentId,
        sessionIds: args.session_ids as string[] | undefined,
        since: args.since as number | undefined,
        until: args.until as number | undefined,
        groupBy: args.group_by as 'session' | 'message' | undefined,
        limit: args.limit as number | undefined,
        snippetChars: args.snippet_chars as number | undefined,
        includeArchived: args.include_archived === true,
      });
      return applyL1(
        options,
        'session_search',
        raw,
        'Narrow query, raise limit later, or session_read specific refs.',
      );
    },
  };
}

export function createSessionReadTool(options: SessionHistoryToolOptions): RegisteredTool {
  return {
    definition: {
      name: 'session_read',
      description:
        'Open a window of past session messages around a hit (`ref` from session_search) or index. Returns transcript lines. Read-only. Use after session_search to recover original context.',
      parameters: {
        session_id: { type: 'string', description: 'Session id', required: true },
        around_ref: {
          type: 'string',
          description: 'Hit ref from session_search, e.g. "sess#12"',
        },
        around_index: { type: 'number', description: 'Message index (if no ref)' },
        before: { type: 'number', description: 'Messages before center (default 2, max 20)', minimum: 0, maximum: 20 },
        after: { type: 'number', description: 'Messages after center (default 3, max 20)', minimum: 0, maximum: 20 },
        include_tool_io: { type: 'boolean', description: 'Include tool args/results in text (default false)' },
        format: {
          type: 'string',
          description: 'transcript (default, compact) or messages (JSON per line)',
          enum: ['transcript', 'messages'],
        },
        include_archived: { type: 'boolean', description: 'Allow reading from cold archive (default false)' },
      },
      timeoutMs: 30_000,
    },
    handler: async (args, context) => {
      const window = await options.history.open({
        sessionId: String(args.session_id ?? ''),
        agentId: context.agentId,
        aroundRef: args.around_ref as string | undefined,
        aroundIndex: args.around_index as number | undefined,
        before: args.before as number | undefined,
        after: args.after as number | undefined,
        includeToolIo: args.include_tool_io === true,
        format: args.format as 'transcript' | 'messages' | undefined,
        includeArchived: args.include_archived === true,
      });
      if (!window) {
        return { found: false, message: 'session not found or not visible' };
      }
      return applyL1(
        options,
        'session_read',
        { found: true, ...window },
        'Reduce before/after, or session_search for a tighter ref.',
      );
    },
  };
}

async function applyL1(
  options: SessionHistoryToolOptions,
  tool: string,
  body: object,
  truncateHint: string,
): Promise<unknown> {
  const rawBody = JSON.stringify(body);
  try {
    const { applyToolOutputGate, resolveSupportBinding } = await import(
      '../../capabilities/summary/index.js'
    );
    const binding = resolveSupportBinding(tool, options.summary, 8000);
    const applied = await applyToolOutputGate({
      tool,
      rawBody,
      support: { ...options.summary, binding },
      truncateHint,
    });
    if (!applied.bodyTruncated) return body;
    return { truncated: true, hint: truncateHint, data: applied.body, rawLength: applied.rawLength };
  } catch {
    if (rawBody.length <= 8000) return body;
    return {
      truncated: true,
      hint: truncateHint,
      data: rawBody.slice(0, 8000),
      rawLength: rawBody.length,
    };
  }
}
