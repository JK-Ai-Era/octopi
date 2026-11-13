/**
 * T3b 结构锚：createKnowledgeClientTools（生产 client 分支）经 run 归属把租户断言
 * 传给 KnowledgeClient —— T3a 演练只锚了本地 retriever 分支，这条才是生产路径。
 */

import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Message, RegisteredTool } from '@octopi-agent/core/types.js';
import type {
  LLMRequest,
  LLMResponse,
  ModelProvider,
} from '@octopi-agent/core/interfaces/model-provider.js';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import { InMemorySessionStore } from '@octopi-agent/engine/harness/session/in-memory-store.js';
import { createKnowledgeClientTools } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/knowledge.js';
import {
  KnowledgeClient,
  runTenantClaimProvider,
} from '@octopi-agent/engine/harness/knowledge/client.js';
import { withRunScope } from '@octopi-agent/engine/harness/run/run-scope.js';
import { DEFAULT_TENANT_ID } from '@octopi-agent/core/types.js';

describe('runTenantClaimProvider 语义（断言优先级与 run 边界）', () => {
  it('run 外=无断言（宿主面）；run 内=run 租户（DEFAULT 兜底）；显式 opts > provider', async () => {
    const seen: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      seen.push(req.headers['x-octopi-tenant'] as string | undefined);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { id: 'ks_x', hits: [] } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new KnowledgeClient({ baseUrl: `http://127.0.0.1:${port}`, token: 't' });
      client.setTenantProvider(runTenantClaimProvider());

      // run 外：无断言（宿主面 = broker 全量语义）
      await client.getSource('ks_x');
      expect(seen[0]).toBeUndefined();

      // run 内（有归属）：断言 run 租户
      const gen = (async function* () {
        await client.getSource('ks_x');
        yield 'x';
      })();
      for await (const _ of withRunScope(
        { runId: 'r1', principal: { tenantId: 't-a' } } as Parameters<typeof withRunScope>[0],
        gen,
      )) {
        void _;
      }
      expect(seen[1]).toBe('t-a');

      // run 内（无归属）：DEFAULT 兜底（fail-closed，绝不放行 broker 全量）
      const gen2 = (async function* () {
        await client.getSource('ks_x');
        yield 'x';
      })();
      for await (const _ of withRunScope({ runId: 'r2', principal: {} } as Parameters<typeof withRunScope>[0], gen2)) {
        void _;
      }
      expect(seen[2]).toBe(DEFAULT_TENANT_ID);

      // 显式 opts > provider
      const gen3 = (async function* () {
        await client.createSource({}, { tenantId: 't-explicit' });
        yield 'x';
      })();
      for await (const _ of withRunScope(
        { runId: 'r3', principal: { tenantId: 't-a' } } as Parameters<typeof withRunScope>[0],
        gen3,
      )) {
        void _;
      }
      expect(seen[3]).toBe('t-explicit');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

describe('client 分支租户断言（createKnowledgeClientTools）', () => {
  it('knowledge_search 经 client 调用携带 run 归属租户', async () => {
    const calls: Array<{ method: string; opts: Record<string, unknown> }> = [];
    const fakeClient = {
      ensurePrincipal: async () => ({}),
      search: async (_agentId: string, _q: string, opts?: Record<string, unknown>) => {
        calls.push({ method: 'search', opts: (opts ?? {}) as Record<string, unknown> });
        return { hits: [], keywordHits: 0, vectorHits: 0 };
      },
      read: async (_agentId: string, _body: unknown, opts?: Record<string, unknown>) => {
        calls.push({ method: 'read', opts: (opts ?? {}) as Record<string, unknown> });
        return { found: false };
      },
    } as any;

    function scriptedProvider(): ModelProvider {
      let call = 0;
      return {
        name: 'mock',
        defaultModel: 'm',
        async chat(_req: LLMRequest): Promise<LLMResponse> {
          call++;
          if (call === 1) {
            return {
              content: '',
              model: 'm',
              finishReason: 'tool_calls',
              toolCalls: [{ id: 'c1', name: 'knowledge_search', arguments: { query: 'alpha' } }],
            };
          }
          return { content: 'done', model: 'm', finishReason: 'stop' };
        },
        async *stream() {
          yield { type: 'done' as const };
        },
        async isAvailable() {
          return true;
        },
        getModelInfo() {
          return { name: 'm', contextWindow: 8000 };
        },
        getModelInfos() {
          return [{ name: 'm', contextWindow: 8000 }];
        },
      } as ModelProvider;
    }

    const builder = new AgentBuilder()
      .model(scriptedProvider())
      .store(new InMemorySessionStore())
      .agentId('agent-x')
      .tenantId('t-a')
      .persona('hi');
    for (const tool of createKnowledgeClientTools({
      client: fakeClient,
    }) as RegisteredTool[]) {
      builder.tool(tool);
    }
    const built = await builder.build();

    const user: Message = { role: 'user', content: '搜一下', timestamp: Date.now() };
    for await (const ev of built.runner.handle('kn-client:1', user, {
      agentId: 'agent-x',
      sessionId: 'kn-client:1',
      systemPrompt: '',
    })) {
      if (ev.type === 'engine.end' || ev.type === 'engine.error') break;
    }

    const search = calls.find((c) => c.method === 'search');
    expect(search).toBeDefined();
    // run 归属租户（agent tenantId 兜底锚定）随调用上行
    expect(search!.opts.tenantId).toBe('t-a');
  }, 30_000);
});
