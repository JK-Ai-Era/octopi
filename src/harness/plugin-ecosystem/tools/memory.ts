/**
 * memory_store / memory_search 工具 — 命题槽位写入 + 可搜 shadow
 *
 * 写入经 confidence + gates；检索含 shadow、排除 deleted。
 */

import type { RegisteredTool } from '../../../core/types.js';
import type { MemoryChannel, MemoryStore, MemoryType } from '../../memory/types.js';
import { MEMORY_TYPES } from '../../memory/types.js';
import { provisionalConfidence, type ConfidenceProfileConfig } from '../../memory/confidence.js';
import { evaluateGates, type GateConfig } from '../../memory/gates.js';
import { findDuplicate } from '../../memory/similarity.js';

const CHANNELS: MemoryChannel[] = [
  'user_directive',
  'decision',
  'fail_fix',
  'model_inference',
  'admin',
];

export interface MemoryToolOptions {
  confidence?: ConfidenceProfileConfig;
  gates?: GateConfig;
  /** 每次触发默认最大写入条数提示（工具描述用） */
  maxWritesPerTrigger?: number;
}

/** 创建记忆工具集 */
export function createMemoryTools(store: MemoryStore, options?: MemoryToolOptions): RegisteredTool[] {
  return [createMemoryStoreTool(store, options), createMemorySearchTool(store)];
}

export function createMemoryStoreTool(store: MemoryStore, options?: MemoryToolOptions): RegisteredTool {
  return {
    definition: {
      name: 'memory_store',
      description:
        'Store one atomic memory proposition for future sessions. Use only when salience checks pass. Types: fact | method | norm. If a search hit is obsolete/conflicting, set supersedes_id to that memory id (soft-delete old, write new). Never claim memory was saved without calling this tool.',
      parameters: {
        type: {
          type: 'string',
          description: 'fact | method | norm',
          required: true,
          enum: [...MEMORY_TYPES],
        },
        proposition: {
          type: 'string',
          description: 'Atomic proposition with concrete anchors (tool/path/quote/version)',
          required: true,
        },
        evidence: {
          type: 'string',
          description: 'Quoted user text or locatable basis; required for non-admin channels. Prefer actual quotes for model_inference.',
          required: true,
        },
        future_use: {
          type: 'string',
          description: 'When to apply: "When X, do/avoid Y"',
        },
        anchors: {
          type: 'array',
          description: 'Retrieval anchors',
          items: { type: 'string', description: 'anchor' },
        },
        channel: {
          type: 'string',
          description: 'How this was recognized (LLM judgment, not keyword rules)',
          required: true,
          enum: CHANNELS.filter((c) => c !== 'admin'),
        },
        supersedes_id: {
          type: 'string',
          description:
            'Existing memory id from memory_search to supersede when this proposition replaces an obsolete/conflicting stored conclusion. Only use ids you actually saw in search results.',
        },
        importance: { type: 'number', description: '0-1 optional', minimum: 0, maximum: 1 },
        tags: { type: 'array', description: 'optional tags', items: { type: 'string', description: 'tag' } },
      },
    },
    handler: async (args, context) => {
      const type = args.type as MemoryType;
      const proposition = String(args.proposition ?? '').trim();
      const evidence = String(args.evidence ?? '').trim();
      const futureUse = args.future_use ? String(args.future_use) : undefined;
      const anchors = Array.isArray(args.anchors) ? (args.anchors as string[]) : [];
      const channel = (args.channel as MemoryChannel) ?? 'model_inference';
      const supersedesId = args.supersedes_id ? String(args.supersedes_id).trim() : undefined;

      const gate = evaluateGates(
        { type, proposition, evidence, futureUse, anchors, channel },
        options?.gates,
      );
      if (!gate.ok) {
        return { stored: false, rejected: true, reason: gate.reason, message: gate.message };
      }

      // supersede 前置校验：id 必须存在且未软删；失败则不写新条、不动旧条
      let previous: Awaited<ReturnType<MemoryStore['get']>> | undefined;
      if (supersedesId) {
        previous = await store.get(supersedesId);
        if (!previous || previous.deleted) {
          return {
            stored: false,
            rejected: true,
            reason: 'supersedes_id_not_found',
            message: `supersedes_id ${supersedesId} not found or already deleted; store with memory_search first`,
          };
        }
      }

      // 写路径 G5：全等拒 duplicate；近重复提示 supersedes_id（显式纠正，不靠语义正则）
      const live = await store.listForGovern({ includeDeleted: false });
      const dup = findDuplicate(live, { type, proposition }, { excludeId: supersedesId });
      if (dup) {
        return {
          stored: false,
          rejected: true,
          reason: 'duplicate',
          existingId: dup.id,
          message: dup.exact
            ? `exact duplicate of ${dup.id}; pass supersedes_id=${dup.id} if replacing`
            : supersedesId
              ? `near-duplicate of ${dup.id} (not the superseded id); rewrite or supersede ${dup.id}`
              : `near-duplicate of ${dup.id}; pass supersedes_id=${dup.id} if replacing it`,
        };
      }

      const conf = provisionalConfidence({
        channel,
        evidence,
        anchors,
        importance: args.importance as number | undefined,
        profile: options?.confidence,
      });

      const status = gate.status === 'shadow' ? 'shadow' : conf.status;
      const tags = [...new Set([...((args.tags as string[]) ?? []), channel, type])];
      if (supersedesId) tags.push('supersede');

      const id = await store.store({
        type,
        content: proposition,
        source: `session:${context.sessionId ?? 'unknown'}`,
        confidence: conf.confidence,
        importance: conf.importance,
        tags,
        channel,
        status,
        futureUse,
        anchors,
        evidence,
      });

      // 先写新条再软删旧条，避免写失败导致旧结论丢失
      if (supersedesId && previous) {
        await store.softDelete(supersedesId, {
          by: 'memory_store.supersede',
          reason: 'superseded',
          winnerId: id,
        });
      }

      return {
        id,
        stored: true,
        type,
        status,
        confidence: conf.confidence,
        importance: conf.importance,
        content: proposition,
        supersededId: supersedesId ?? null,
      };
    },
  };
}

export function createMemorySearchTool(store: MemoryStore): RegisteredTool {
  return {
    definition: {
      name: 'memory_search',
      description:
        'Search long-term memory propositions by text. Results include memory `id` for follow-up (e.g. memory_store.supersedes_id when replacing an obsolete conclusion). Includes shadow entries (hypotheses only). Excludes soft-deleted entries. Use concrete entity names as query terms.',
      parameters: {
        query: { type: 'string', description: 'Search query (prefer entities)', required: true },
        type: { type: 'string', description: 'Filter by type', enum: [...MEMORY_TYPES] },
        min_importance: { type: 'number', description: 'Minimum importance 0-1', minimum: 0, maximum: 1 },
        include_shadow: {
          type: 'boolean',
          description: 'Include shadow memories as weak leads (default true for search)',
        },
        limit: { type: 'number', description: 'Max results (default 10)', minimum: 1, maximum: 50 },
      },
    },
    handler: async (args) => {
      const includeShadow = args.include_shadow !== false;
      const results = await store.retrieve({
        text: String(args.query ?? ''),
        type: args.type as MemoryType | undefined,
        minImportance: (args.min_importance as number) ?? 0,
        limit: Math.min((args.limit as number) ?? 10, 50),
        updateAccess: true,
        includeShadow,
        includeDeleted: false,
      });
      return {
        results: results.map((e) => ({
          id: e.id,
          type: e.type,
          content: e.content,
          status: e.status ?? 'active',
          channel: e.channel,
          importance: e.importance,
          confidence: e.confidence,
          futureUse: e.futureUse,
          tags: e.tags,
          createdAt: e.createdAt,
          accessCount: e.accessCount,
        })),
        total: results.length,
      };
    },
  };
}
