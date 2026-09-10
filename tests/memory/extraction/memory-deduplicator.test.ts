import { describe, it, expect } from 'vitest';
import { InMemoryMemoryStore } from '../../../src/harness/memory/store.js';
import { MemoryDeduplicator } from '../../../src/subsystems/memory-extractor/policies/dedup.js';
import type { MemoryCandidate } from '../../../src/subsystems/memory-extractor/contracts/bundle.js';

function candidate(overrides?: Partial<MemoryCandidate>): MemoryCandidate {
  return {
    type: 'decision',
    content: 'Use SQLite for extractor store',
    source: 'session:s1;turns:t1',
    evidence: ['e1'],
    confidence: 0.8,
    importance: 0.8,
    tags: ['decision'],
    ...overrides,
  };
}

describe('MemoryDeduplicator', () => {
  it('should accept first candidate and dedupe same source next time', async () => {
    const store = new InMemoryMemoryStore();
    const deduper = new MemoryDeduplicator(store);

    const first = await deduper.filterAndUpgrade([candidate()]);
    expect(first.length).toBe(1);

    // store the first
    await store.store({
      type: first[0].type,
      content: first[0].content,
      source: first[0].source,
      confidence: first[0].confidence,
      importance: first[0].importance,
      tags: first[0].tags,
    });

    // same source should be filtered (dedupe)
    const second = await deduper.filterAndUpgrade([candidate()]);
    expect(second.length).toBe(0);
  });

  it('should upgrade existing when incoming confidence higher', async () => {
    const store = new InMemoryMemoryStore();
    const deduper = new MemoryDeduplicator(store, { upgradeDelta: 0.02 });

    // seed existing (must include source tag for tag-based dedupe)
    const id = await store.store({
      type: 'decision',
      content: 'Use SQLite for extractor store',
      source: 'session:s1;turns:t1',
      confidence: 0.7,
      importance: 0.7,
      tags: ['decision', 'session:s1;turns:t1'],
    });

    const incoming = candidate({ confidence: 0.85, importance: 0.85 });
    const accepted = await deduper.filterAndUpgrade([incoming]);

    // No new accepted (upgrade instead)
    expect(accepted.length).toBe(0);

    const updated = await store.get(id);
    expect(updated?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(updated?.importance).toBeGreaterThanOrEqual(0.85);
  });
});
