/**
 * KnowledgeClient 超时不得再吐 DOMException「This operation was aborted」
 */
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KnowledgeClient } from '@octopi-agent/engine/harness/knowledge/client.js';

describe('KnowledgeClient timeout error', () => {
  it('超时抛 knowledge_http_timeout，而非 This operation was aborted', async () => {
    const server = createServer((_req, res) => {
      // 永不响应，逼客户端超时
      void res;
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const client = new KnowledgeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: 't',
      timeoutMs: 200,
    });
    try {
      await client.health();
      expect.unreachable('should timeout');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/knowledge_http_timeout/);
      expect(msg).not.toMatch(/This operation was aborted/i);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
