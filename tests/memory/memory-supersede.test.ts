/**
 * memory_store.supersedes_id 最小闭环：search 拿 id → store 冲突命题并软删旧条
 */
import { describe, it, expect } from 'vitest';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import { createMemoryStoreTool, createMemorySearchTool } from '../../src/harness/plugin-ecosystem/tools/memory.js';
import { loadConstitution } from '../../src/harness/context/constitution/load-constitution.js';

const ctx = { sessionId: 'sess-supersede' };

describe('memory_store.supersedes_id', () => {
  it('search exposes id; store supersedes old conclusion (soft-delete)', async () => {
    const store = new InMemoryMemoryStore();
    const storeTool = createMemoryStoreTool(store);
    const searchTool = createMemorySearchTool(store);

    const first = (await storeTool.handler(
      {
        type: 'fact',
        proposition: 'Memory backend uses Redis cache on port 6379',
        evidence: '"我们定过了用 Redis"',
        channel: 'decision',
        future_use: 'When configuring memory backend use Redis 6379',
        anchors: ['Redis', '6379'],
      },
      ctx,
    )) as { stored: boolean; id: string };
    expect(first.stored).toBe(true);
    const oldId = first.id;

    const search = (await searchTool.handler({ query: 'Redis memory backend' }, ctx)) as {
      results: Array<{ id: string; content: string }>;
    };
    expect(search.results.length).toBeGreaterThan(0);
    const hit = search.results.find((r) => r.content.includes('Redis'));
    expect(hit?.id).toBe(oldId);

    const second = (await storeTool.handler(
      {
        type: 'fact',
        proposition: 'Memory backend uses SqliteMemoryStore on agent.db not Redis',
        evidence: '"改用 SqliteMemoryStore 挂 agent.db"',
        channel: 'user_directive',
        future_use: 'When configuring memory use SqliteMemoryStore on agent.db',
        anchors: ['SqliteMemoryStore', 'agent.db'],
        supersedes_id: hit!.id,
      },
      ctx,
    )) as { stored: boolean; id: string; supersededId: string };

    expect(second.stored).toBe(true);
    expect(second.supersededId).toBe(oldId);

    const oldEntry = await store.get(oldId);
    expect(oldEntry?.deleted).toBe(true);
    expect(oldEntry?.deletedReason).toBe('superseded');

    const active = await store.retrieve({ text: 'Redis', includeShadow: false });
    expect(active.find((e) => e.id === oldId)).toBeUndefined();
    const stillThere = await store.retrieve({ text: 'SqliteMemoryStore', includeShadow: false });
    expect(stillThere.some((e) => e.id === second.id)).toBe(true);
  });

  it('rejects unknown supersedes_id without writing', async () => {
    const store = new InMemoryMemoryStore();
    const storeTool = createMemoryStoreTool(store);
    const out = (await storeTool.handler(
      {
        type: 'fact',
        proposition: 'Project convention uses npm not pnpm',
        evidence: '"用 npm"',
        channel: 'decision',
        anchors: ['npm', 'pnpm'],
        supersedes_id: 'mem_does_not_exist',
      },
      ctx,
    )) as { stored: boolean; reason?: string };
    expect(out.stored).toBe(false);
    expect(out.reason).toBe('supersedes_id_not_found');
    const stats = await store.stats();
    expect(stats.totalEntries).toBe(0);
  });

  it('constitution documents search-before-supersede and supersedes_id', () => {
    const { text } = loadConstitution({ mode: 'product' });
    expect(text).toContain('supersedes_id');
    expect(text).toContain('memory_search');
    expect(text.toLowerCase()).toContain('supersede');
    // 原则句：不是主题白名单
    expect(text).toContain('examples, not an exhaustive filter');
    expect(text.toLowerCase()).toContain('fact`/`norm`');
  });
});
