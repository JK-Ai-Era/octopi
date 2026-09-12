/**
 * memory_store / memory_search 工具 — Agent 记忆读写
 *
 * 通过工厂函数接收 MemoryStore 实例（闭包注入），消除 context.services 类型黑洞。
 */

import type { RegisteredTool, ToolExecutionContext } from '../../../core/types.js';
import type { MemoryStore, MemoryType } from '../../memory/types.js';

/** 创建记忆工具集 */
export function createMemoryTools(store: MemoryStore): RegisteredTool[] {
  return [createMemoryStoreTool(store), createMemorySearchTool(store)];
}

/** memory_store 工具 — 存储记忆 */
export function createMemoryStoreTool(store: MemoryStore): RegisteredTool {
  return {
    definition: {
      name: 'memory_store',
      description: 'Store a memory entry for long-term recall across sessions. Use to remember user preferences, important decisions, lessons learned, and key discoveries.',
      parameters: {
        content: { type: 'string', description: 'The memory content in natural language', required: true },
        type: { type: 'string', description: 'Memory type', required: true, enum: ['preference', 'decision', 'lesson', 'discovery', 'context', 'relationship'] },
        importance: { type: 'number', description: 'Importance score 0-1 (default: 0.5)', minimum: 0, maximum: 1 },
        confidence: { type: 'number', description: 'Confidence score 0-1 (default: 0.8)', minimum: 0, maximum: 1 },
        tags: { type: 'array', description: 'Tags for categorization', items: { type: 'string', description: 'A tag' } },
      },
    },
    handler: async (args, context) => {
      const id = await store.store({
        type: args.type as MemoryType,
        content: args.content as string,
        source: context.sessionId,
        confidence: (args.confidence as number) ?? 0.8,
        importance: (args.importance as number) ?? 0.5,
        tags: (args.tags as string[]) ?? [],
      });
      return { id, stored: true, type: args.type, content: args.content };
    },
  };
}

/** memory_search 工具 — 搜索记忆 */
export function createMemorySearchTool(store: MemoryStore): RegisteredTool {
  return {
    definition: {
      name: 'memory_search',
      description: 'Search stored memories by text query. Retrieves relevant memories from past sessions. Use to recall user preferences, past decisions, and lessons learned.',
      parameters: {
        query: { type: 'string', description: 'Search query text', required: true },
        type: { type: 'string', description: 'Filter by memory type (optional)', enum: ['preference', 'decision', 'lesson', 'discovery', 'context', 'relationship'] },
        min_importance: { type: 'number', description: 'Minimum importance threshold 0-1 (default: 0)', minimum: 0, maximum: 1 },
        limit: { type: 'number', description: 'Maximum number of results (default: 10, max: 50)', minimum: 1, maximum: 50 },
      },
    },
    handler: async (args, context) => {
      const results = await store.retrieve({
        text: args.query as string,
        type: args.type as MemoryType | undefined,
        minImportance: (args.min_importance as number) ?? 0,
        limit: Math.min((args.limit as number) ?? 10, 50),
        updateAccess: true,
      });
      return {
        results: results.map((e) => ({ id: e.id, type: e.type, content: e.content, importance: e.importance, confidence: e.confidence, tags: e.tags, createdAt: e.createdAt, accessCount: e.accessCount })),
        total: results.length,
      };
    },
  };
}
