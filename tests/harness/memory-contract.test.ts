/**
 * Memory 契约测试 — InMemory 实现必须满足 harness/memory MemoryStore 契约
 */

import { describe, it, expect } from 'vitest';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import type { MemoryStore, MemoryEntry } from '../../src/harness/memory/types.js';

function sampleEntry(overrides?: Partial<Parameters<MemoryStore['store']>[0]>) {
  return {
    type: 'lesson' as const,
    content: 'always flush persist before asserting store',
    source: 'session-1',
    confidence: 0.8,
    importance: 0.6,
    tags: ['core', 'test'],
    ...overrides,
  };
}

describe('MemoryStore contract (InMemoryMemoryStore)', () => {
  it('store 返回 id，get 可读回', async () => {
    const store: MemoryStore = new InMemoryMemoryStore();
    const id = await store.store(sampleEntry());
    expect(id).toBeTruthy();
    const got = await store.get(id);
    expect(got?.content).toContain('flush persist');
    expect(got?.type).toBe('lesson');
    expect(got?.tags).toContain('core');
  });

  it('retrieve 按文本/标签过滤', async () => {
    const store = new InMemoryMemoryStore();
    await store.store(sampleEntry({ content: 'typescript strict', tags: ['ts'] }));
    await store.store(sampleEntry({ content: 'python typing', tags: ['py'], type: 'discovery' }));

    const hits = await store.retrieve({ text: 'typescript', limit: 10 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].content).toContain('typescript');

    const byTag = await store.retrieve({ text: '', tags: ['py'], limit: 10 });
    expect(byTag.some((e: MemoryEntry) => e.type === 'discovery')).toBe(true);
  });

  it('update 局部补丁', async () => {
    const store = new InMemoryMemoryStore();
    const id = await store.store(sampleEntry());
    await store.update(id, { importance: 0.99, content: 'updated' });
    const got = await store.get(id);
    expect(got?.importance).toBe(0.99);
    expect(got?.content).toBe('updated');
  });

  it('delete 后 get 为 null', async () => {
    const store = new InMemoryMemoryStore();
    const id = await store.store(sampleEntry());
    await store.delete(id);
    expect(await store.get(id)).toBeNull();
  });

  it('stats 聚合', async () => {
    const store = new InMemoryMemoryStore();
    await store.store(sampleEntry());
    await store.store(sampleEntry({ type: 'preference', content: 'likes dark mode' }));
    const stats = await store.stats();
    expect(stats.totalEntries).toBe(2);
    expect(stats.byType.lesson).toBe(1);
    expect(stats.byType.preference).toBe(1);
  });
});
