import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderPool } from '../../src/harness/concurrency/provider-pool.js';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk, ModelInfo } from '../../src/core/interfaces/model-provider.js';

// ── Mock Provider ──

function createMockProvider(opts: {
  name?: string;
  defaultModel?: string;
  chatFn?: (req: LLMRequest) => Promise<LLMResponse>;
  streamFn?: (req: LLMRequest) => AsyncGenerator<LLMStreamChunk>;
} = {}): ModelProvider {
  const name = opts.name ?? 'mock';
  return {
    name,
    defaultModel: opts.defaultModel ?? 'mock-model',
    getModelInfo: (_model: string): ModelInfo | null => null,
    chat: opts.chatFn ?? (async () => ({
      content: `response from ${name}`,
      model: opts.defaultModel ?? 'mock-model',
      finishReason: 'stop' as const,
    })),
    stream: opts.streamFn ?? (async function* () {
      yield { type: 'content' as const, content: `stream from ${name}` };
      yield { type: 'done' as const };
    }),
  };
}

function makeProviderMap(...providers: ModelProvider[]): Map<string, ModelProvider> {
  const map = new Map<string, ModelProvider>();
  for (const p of providers) {
    map.set(p.name, p);
  }
  return map;
}

// ── Tests ──

describe('ProviderPool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('construction', () => {
    it('should create pool with valid config', () => {
      const p1 = createMockProvider({ name: 'key-1' });
      const pool = new ProviderPool(
        { slots: [{ provider: 'key-1' }] },
        makeProviderMap(p1),
      );

      expect(pool.name).toBe('provider-pool');
      expect(pool.defaultModel).toBe('mock-model');

      pool.destroy();
    });

    it('should throw if provider not found in map', () => {
      expect(() => {
        new ProviderPool(
          { slots: [{ provider: 'nonexistent' }] },
          new Map(),
        );
      }).toThrow('not found in provider map');
    });

    it('should throw if no slots', () => {
      expect(() => {
        new ProviderPool({ slots: [] }, new Map());
      }).toThrow('at least one slot');
    });
  });

  describe('chat routing', () => {
    it('should route to a single slot', async () => {
      const p1 = createMockProvider({ name: 'key-1' });
      const pool = new ProviderPool(
        { slots: [{ provider: 'key-1' }] },
        makeProviderMap(p1),
      );

      const response = await pool.chat({ messages: [] });
      expect(response.content).toBe('response from key-1');

      pool.destroy();
    });

    it('should distribute across multiple slots', async () => {
      const responses: string[] = [];
      const p1 = createMockProvider({
        name: 'key-1',
        chatFn: async () => { responses.push('key-1'); return { content: 'r1', model: 'm', finishReason: 'stop' }; },
      });
      const p2 = createMockProvider({
        name: 'key-2',
        chatFn: async () => { responses.push('key-2'); return { content: 'r2', model: 'm', finishReason: 'stop' }; },
      });

      // Use round-robin for deterministic distribution
      const pool = new ProviderPool(
        {
          slots: [{ provider: 'key-1' }, { provider: 'key-2' }],
          routing: { strategy: 'round-robin' },
        },
        makeProviderMap(p1, p2),
      );

      await pool.chat({ messages: [] });
      await pool.chat({ messages: [] });

      // Round-robin should alternate
      expect(responses[0]).toBe('key-1');
      expect(responses[1]).toBe('key-2');

      pool.destroy();
    });
  });

  describe('stream routing', () => {
    it('should stream from a slot', async () => {
      const p1 = createMockProvider({ name: 'key-1' });
      const pool = new ProviderPool(
        { slots: [{ provider: 'key-1' }] },
        makeProviderMap(p1),
      );

      const chunks: LLMStreamChunk[] = [];
      for await (const chunk of pool.stream({ messages: [] })) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBe(2);
      expect(chunks[0].content).toBe('stream from key-1');

      pool.destroy();
    });
  });

  describe('sticky routing', () => {
    it('should route same session to same slot', async () => {
      const calls: string[] = [];
      const p1 = createMockProvider({
        name: 'key-1',
        chatFn: async () => { calls.push('key-1'); return { content: 'r1', model: 'm', finishReason: 'stop' }; },
      });
      const p2 = createMockProvider({
        name: 'key-2',
        chatFn: async () => { calls.push('key-2'); return { content: 'r2', model: 'm', finishReason: 'stop' }; },
      });

      const pool = new ProviderPool(
        {
          slots: [{ provider: 'key-1' }, { provider: 'key-2' }],
          routing: { strategy: 'sticky' },
        },
        makeProviderMap(p1, p2),
      );

      // Simulate requests with session IDs via signal
      const makeRequest = (sessionId: string) => {
        const ctrl = new AbortController();
        (ctrl.signal as any).__sessionId = sessionId;
        return { messages: [], signal: ctrl.signal };
      };

      const reqA = makeRequest('session-a');
      const reqB = makeRequest('session-b');

      await pool.chat(reqA);
      await pool.chat(reqA); // same session
      await pool.chat(reqB);

      // Session A should be sticky to one key
      expect(calls[0]).toBe(calls[1]); // same provider for session A
      // Session B might be the same or different (random), but at least we tested stickiness

      pool.destroy();
    });
  });

  describe('weighted round-robin', () => {
    it('should respect weights', async () => {
      const calls: string[] = [];
      const p1 = createMockProvider({
        name: 'key-1',
        chatFn: async () => { calls.push('key-1'); return { content: 'r1', model: 'm', finishReason: 'stop' }; },
      });
      const p2 = createMockProvider({
        name: 'key-2',
        chatFn: async () => { calls.push('key-2'); return { content: 'r2', model: 'm', finishReason: 'stop' }; },
      });

      const pool = new ProviderPool(
        {
          slots: [
            { provider: 'key-1', weight: 2 },
            { provider: 'key-2', weight: 1 },
          ],
          routing: { strategy: 'round-robin' },
        },
        makeProviderMap(p1, p2),
      );

      // 6 calls: key-1 should get 4, key-2 should get 2 (2:1 ratio)
      for (let i = 0; i < 6; i++) {
        await pool.chat({ messages: [] });
      }

      const k1Count = calls.filter(c => c === 'key-1').length;
      const k2Count = calls.filter(c => c === 'key-2').length;
      expect(k1Count).toBe(4);
      expect(k2Count).toBe(2);

      pool.destroy();
    });
  });

  describe('health tracking', () => {
    it('should mark slot unhealthy after 5 consecutive errors', async () => {
      let callCount = 0;
      const p1 = createMockProvider({
        name: 'key-1',
        chatFn: async () => {
          callCount++;
          throw new Error('rate limited');
        },
      });

      // 单 slot，所有调用都打到 key-1
      const pool = new ProviderPool(
        { slots: [{ provider: 'key-1' }] },
        makeProviderMap(p1),
      );

      for (let i = 0; i < 5; i++) {
        await pool.chat({ messages: [] }).catch(() => {});
      }

      const metrics = pool.getSlotMetrics();
      expect(metrics[0].healthy).toBe(false);
      expect(metrics[0].consecutiveErrors).toBe(5);

      pool.destroy();
    });

    it('should recover slot health on success', async () => {
      let callCount = 0;
      const p1 = createMockProvider({
        name: 'key-1',
        chatFn: async () => {
          callCount++;
          if (callCount <= 5) throw new Error('error');
          return { content: 'ok', model: 'm', finishReason: 'stop' };
        },
      });

      const pool = new ProviderPool(
        { slots: [{ provider: 'key-1' }] },
        makeProviderMap(p1),
      );

      // 5 errors
      for (let i = 0; i < 5; i++) {
        await pool.chat({ messages: [] }).catch(() => {});
      }
      expect(pool.getSlotMetrics()[0].healthy).toBe(false);

      // Success → recover
      await pool.chat({ messages: [] });
      expect(pool.getSlotMetrics()[0].healthy).toBe(true);
      expect(pool.getSlotMetrics()[0].consecutiveErrors).toBe(0);

      pool.destroy();
    });
  });

  describe('sticky map cleanup', () => {
    it('should cleanup expired sticky entries', async () => {
      const p1 = createMockProvider({ name: 'key-1' });
      const pool = new ProviderPool(
        {
          slots: [{ provider: 'key-1' }],
          routing: { stickyTtlMs: 1000 },
        },
        makeProviderMap(p1),
      );

      const ctrl = new AbortController();
      (ctrl.signal as any).__sessionId = 'session-1';
      await pool.chat({ messages: [], signal: ctrl.signal });

      expect(pool.getStickyStats().activeSessions).toBe(1);

      // Advance past TTL
      vi.advanceTimersByTime(61_000); // cleanup runs every 60s

      expect(pool.getStickyStats().activeSessions).toBe(0);

      pool.destroy();
    });
  });

  describe('metrics', () => {
    it('should track slot metrics', async () => {
      const p1 = createMockProvider({ name: 'key-1' });
      const pool = new ProviderPool(
        { slots: [{ provider: 'key-1' }] },
        makeProviderMap(p1),
      );

      await pool.chat({ messages: [] });

      const metrics = pool.getSlotMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0].provider).toBe('key-1');
      expect(metrics[0].healthy).toBe(true);
      expect(metrics[0].totalCalls).toBe(1);

      pool.destroy();
    });
  });

  describe('destroy', () => {
    it('should cleanup all resources', () => {
      const p1 = createMockProvider({ name: 'key-1' });
      const pool = new ProviderPool(
        { slots: [{ provider: 'key-1' }] },
        makeProviderMap(p1),
      );

      pool.destroy();
      // Should be safe to call twice
      pool.destroy();
    });
  });
});
