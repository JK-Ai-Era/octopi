/**
 * 记忆召回带时间 — recorded / as of 时效语义
 */

import { describe, it, expect } from 'vitest';
import { InMemoryMemoryStore } from '@octopi-agent/engine/harness/memory/store.js';
import {
  formatMemoryClock,
  formatMemoryTimeSuffix,
  parseAsOf,
} from '@octopi-agent/engine/harness/memory/time-format.js';
import {
  createMemoryStoreTool,
  createMemorySearchTool,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/memory.js';
import { MemoryLayer } from '@octopi-agent/engine/harness/context/layers.js';
import { AgentDatabase, SqliteMemoryStore } from '@octopi-agent/engine/harness/memory/sqlite/index.js';

function toolArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'fact',
    proposition: 'CI uses Node 24 on main',
    evidence: 'user said: we moved to Node 24 last week',
    channel: 'user_directive',
    importance: 0.9,
    tags: ['env'],
    anchors: ['Node', 'CI'],
    ...extra,
  };
}

describe('formatMemoryClock / parseAsOf', () => {
  it('formats local clock to minute precision', () => {
    const ms = new Date(2026, 2, 1, 14, 30, 45).getTime();
    expect(formatMemoryClock(ms)).toBe('2026-03-01 14:30');
  });

  it('parses date string, numeric string, and epoch', () => {
    const fromDate = parseAsOf('2026-02-15');
    expect(fromDate).toBe(Date.parse('2026-02-15'));
    expect(parseAsOf('1712345678901')).toBe(1712345678901);
    expect(parseAsOf(1712345678901)).toBe(1712345678901);
    expect(parseAsOf(undefined)).toBeUndefined();
    expect(parseAsOf('')).toBeUndefined();
  });

  it('throws on unparseable as_of', () => {
    expect(() => parseAsOf('not-a-date')).toThrow(/invalid_as_of/);
  });

  it('suffix distinguishes recorded vs as of', () => {
    const created = new Date(2026, 2, 1, 14, 30).getTime();
    const asOf = new Date(2026, 1, 15, 10, 0).getTime();
    expect(formatMemoryTimeSuffix({ createdAt: created })).toContain('recorded 2026-03-01 14:30');
    const both = formatMemoryTimeSuffix({ createdAt: created, asOf });
    expect(both).toContain('as of 2026-02-15 10:00');
    expect(both).toContain('recorded 2026-03-01 14:30');
    expect(formatMemoryTimeSuffix({})).toBe('');
  });
});

describe('memory_store / memory_search time fields', () => {
  it('stores as_of and surfaces recordedAt/asOf on search', async () => {
    const store = new InMemoryMemoryStore();
    const storeTool = createMemoryStoreTool(store);
    const searchTool = createMemorySearchTool(store);

    const write = await storeTool.handler(
      toolArgs({ as_of: '2026-02-15' }) as never,
      { sessionId: 's1' } as never,
    );
    expect(write).toMatchObject({ stored: true, asOf: expect.stringContaining('2026-02-15') });

    const search = (await searchTool.handler({ query: 'Node 24' } as never)) as {
      results: Array<{ recordedAt: string; asOf?: string; createdAt: number }>;
    };
    expect(search.results).toHaveLength(1);
    expect(search.results[0]!.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(search.results[0]!.asOf).toContain('2026-02-15');
  });

  it('rejects invalid as_of without writing', async () => {
    const store = new InMemoryMemoryStore();
    const storeTool = createMemoryStoreTool(store);
    const write = await storeTool.handler(toolArgs({ as_of: 'not-a-date' }) as never, {
      sessionId: 's1',
    } as never);
    expect(write).toMatchObject({ stored: false, rejected: true, reason: 'invalid_as_of' });
    expect(await store.listForGovern()).toHaveLength(0);
  });

  it('search description mentions time freshness', () => {
    const tool = createMemorySearchTool(new InMemoryMemoryStore());
    expect(tool.definition.description).toMatch(/recordedAt|asOf|Current datetime/);
  });
});

describe('MemoryLayer injects time', () => {
  it('annotates each hit with recorded (and as of when present)', async () => {
    const store = new InMemoryMemoryStore();
    const storeTool = createMemoryStoreTool(store);
    await storeTool.handler(toolArgs({ as_of: '2026-02-15' }) as never, {
      sessionId: 's1',
    } as never);

    const layer = new MemoryLayer({ store, limit: 5 });
    const content = await layer.assemble({
      query: 'Node 24 on main',
      tokenBudget: 2000,
      now: Date.now(),
    } as never);

    expect(content).not.toBeNull();
    expect(content!.text).toContain('# 相关记忆');
    expect(content!.text).toMatch(/recorded \d{4}-\d{2}-\d{2}/);
    expect(content!.text).toMatch(/as of \d{4}-\d{2}-\d{2}/);
  });
});

describe('SqliteMemoryStore asOf roundtrip', () => {
  it('persists and returns asOf', async () => {
    const db = await AgentDatabase.create({ dbPath: ':memory:' });
    const store = new SqliteMemoryStore(db);
    const asOf = Date.parse('2026-02-15T10:00:00');
    const id = await store.store({
      type: 'fact',
      content: 'deploy window is Tue 10:00 UTC',
      source: 'session:s1',
      confidence: 0.8,
      importance: 0.7,
      tags: ['ops'],
      channel: 'user_directive',
      status: 'active',
      evidence: 'user: deploy window is Tue',
      anchors: ['deploy'],
      asOf,
    });
    const got = await store.get(id);
    expect(got?.asOf).toBe(asOf);
  });
});
