import { describe, it, expect } from 'vitest';
import { JsonlExtractorStore } from '../../../src/harness/memory/extraction/jsonl-extractor-store.js';
import { InMemoryExtractorStore } from '../../../src/harness/memory/extraction/extractor-store.js';
import type { SessionExtractEvent, SessionExtractBundle } from '../../../src/harness/memory/extraction/session-extractor.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function event(overrides?: Partial<SessionExtractEvent>): SessionExtractEvent {
  return {
    ts: Date.now(),
    type: 'tool_call',
    sessionId: 's1',
    agentId: 'a1',
    payload: {},
    ...overrides,
  };
}

function bundle(overrides?: Partial<SessionExtractBundle>): SessionExtractBundle {
  return {
    sessionId: 's1',
    agentId: 'a1',
    startAt: Date.now(),
    events: [],
    condensedTurns: [],
    runSummary: { totalTurns: 0, totalToolCalls: 0, failureRate: 0, majorErrors: [], resolvedErrors: [] },
    ...overrides,
  };
}

describe('ExtractorStore', () => {
  it('InMemoryExtractorStore append/load/save/load/listPending', async () => {
    const store = new InMemoryExtractorStore();
    await store.appendEvents('a1', 's1', [event(), event({ type: 'tool_success' })]);
    const events = await store.loadEvents('a1', 's1');
    expect(events.length).toBe(2);

    await store.saveBundle('a1', 's1', bundle(), { sessionId: 's1', agentId: 'a1', extractionStatus: 'pending' });
    const loaded = await store.loadBundle('a1', 's1');
    expect(loaded?.sessionId).toBe('s1');

    const pending = await store.listPending('a1');
    expect(pending.some((p) => p.sessionId === 's1')).toBe(true);
  });

  it('JsonlExtractorStore append/load/save/load/listPending', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'octopi-extract-'));
    const store = new JsonlExtractorStore((agentId) => path.join(dir, agentId));

    await store.appendEvents('a1', 's1', [event(), event({ type: 'error' })]);
    const events = await store.loadEvents('a1', 's1');
    expect(events.length).toBe(2);

    await store.saveBundle('a1', 's1', bundle(), { sessionId: 's1', agentId: 'a1', extractionStatus: 'pending' });
    const loaded = await store.loadBundle('a1', 's1');
    expect(loaded?.sessionId).toBe('s1');

    const pending = await store.listPending('a1');
    expect(pending.some((p) => p.sessionId === 's1')).toBe(true);

    // 文件落盘校验
    const eventsFile = path.join(dir, 'a1', 'extract', 'events', 's1.jsonl');
    const content = await readFile(eventsFile, 'utf-8');
    expect(content.split('\n').filter(Boolean).length).toBe(2);
  });
});
