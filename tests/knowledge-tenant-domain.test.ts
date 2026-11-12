/**
 * T3 判据（arch/multi-tenancy.md §6）：跨租户检索不出界；platform 公共库共享正确。
 *
 * - 租户闸（source-store.isTenantVisible）：有归属租户即过滤（不依赖 gatewayId）；
 *   platform 域（PLATFORM_TENANT_ID）全租户可见；租户私有仅本域。
 * - 租户断言（resolveTenantClaim）：platform token 可断言任意域；租户 token 只可断言本域。
 * - run 级 drill：两租户各跑 agent 调 knowledge_search，命中域 = 本域 ∪ platform。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PLATFORM_TENANT_ID, DEFAULT_TENANT_ID } from '@octopi-agent/core/types.js';
import type { Message, RegisteredTool } from '@octopi-agent/core/types.js';
import type { ModelProvider, LLMRequest, LLMResponse } from '@octopi-agent/core/interfaces/model-provider.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { LocalKnowledgeWriteService } from '@octopi-agent/engine/harness/knowledge/writer-service.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeRetriever } from '@octopi-agent/engine/harness/knowledge/retriever.js';
import { resolveTenantClaim } from '@octopi-agent/engine/harness/knowledge/http-bridge.js';
import { createKnowledgeTools } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/knowledge.js';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import { InMemorySessionStore } from '@octopi-agent/engine/harness/session/in-memory-store.js';

async function openStack() {
  const store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
  const db = store.database;
  const write = new LocalKnowledgeWriteService({ db });
  const index = new KnowledgeIndexStore(db);
  const retriever = new KnowledgeRetriever({ sourceStore: store, indexStore: index });
  return { store, db, write, index, retriever };
}

/** 注册一个 global 源 + 一段可检索语料 */
async function seedSource(
  stack: Awaited<ReturnType<typeof openStack>>,
  identity: { tenantId: string; gatewayId: string },
  name: string,
  token: string,
): Promise<string> {
  const created = await stack.write.registerSource({ ...identity, claimed: true }, {
    kind: 'directory',
    location: `/tmp/${name}`,
    scopeRef: { level: 'global', key: 'global' },
    displayName: name,
    visibility: 'private',
    sync: { enabled: false, strategy: 'manual' },
  });
  await stack.index.upsertFile({
    sourceId: created.id,
    path: `${name}/doc.md`,
    contentHash: `hash-${name}`,
    size: 100,
    mtime: Date.now(),
    adapterId: 'test',
    chunks: [
      {
        ordinal: 0,
        text: `${token} appears in ${name} corpus`,
        startLine: 1,
        endLine: 1,
        heading: name,
        contentHash: `c-${name}`,
        identityKey: `${name}/doc.md#1`,
      } as never,
    ],
  });
  return String(created.id);
}

describe('T3：knowledge 租户域', () => {
  let stack: Awaited<ReturnType<typeof openStack>>;

  /** 直读执法列（KnowledgeSource 类型面不带 tenantId） */
  function rowTenant(id: string): string {
    return (
      stack.db.raw.prepare('SELECT tenant_id FROM knowledge_sources WHERE id = ?').get(id) as {
        tenant_id: string;
      }
    ).tenant_id;
  }

  beforeEach(async () => {
    stack = await openStack();
  });

  afterEach(() => {
    stack.db.close();
  });

  it('租户闸：本域 ∪ platform 可见，他域不出界（identity 无 gatewayId 亦生效）', async () => {
    const idA = await seedSource(stack, { tenantId: 't-a', gatewayId: 'gw' }, 'a-docs', 'alpha');
    const idB = await seedSource(stack, { tenantId: 't-b', gatewayId: 'gw' }, 'b-docs', 'bravo');
    const idP = await seedSource(stack, { tenantId: PLATFORM_TENANT_ID, gatewayId: 'gw' }, 'p-docs', 'pub');

    const asA = { tenantId: 't-a' };
    const asB = { tenantId: 't-b' };
    const idsA = stack.retriever.visibleSourceIds('agent', undefined, asA).map(String);
    const idsB = stack.retriever.visibleSourceIds('agent', undefined, asB).map(String);

    expect(idsA.sort()).toEqual([idA, idP].sort());
    expect(idsB.sort()).toEqual([idB, idP].sort());
  });

  it('租户闸：DEFAULT 域只见存量 + platform；无归属 fail-closed 到 DEFAULT 域（MAJ-2）', async () => {
    const idLegacy = await seedSource(stack, { tenantId: DEFAULT_TENANT_ID, gatewayId: 'gw' }, 'legacy', 'old');
    const idB = await seedSource(stack, { tenantId: 't-b', gatewayId: 'gw' }, 'b-docs', 'bravo');
    const idP = await seedSource(stack, { tenantId: PLATFORM_TENANT_ID, gatewayId: 'gw' }, 'p-docs', 'pub');

    const idsDefault = stack.retriever
      .visibleSourceIds('agent', undefined, { tenantId: DEFAULT_TENANT_ID })
      .map(String);
    expect(idsDefault.sort()).toEqual([idLegacy, idP].sort());

    // 无归属 = DEFAULT 域（fail-closed）：他租户私有不出界
    const idsUnattributed = stack.retriever.visibleSourceIds('agent', undefined, {}).map(String);
    expect(idsUnattributed.sort()).toEqual([idLegacy, idP].sort());
    expect(idsUnattributed).not.toContain(idB);

    // platform 身份 = broker/运维面：全量
    const idsBroker = stack.retriever
      .visibleSourceIds('agent', undefined, { tenantId: PLATFORM_TENANT_ID })
      .map(String);
    expect(idsBroker.sort()).toEqual([idLegacy, idB, idP].sort());
  });

  it('registerSource 归属打标：claim 在场打 claim 域；platform token 无 claim 降级 default（MAJ-1 修配套）', async () => {
    const broker = { tenantId: PLATFORM_TENANT_ID, gatewayId: 'gw' };
    // 无 claim：降级 default 域，绝不放大成 platform 共享
    const a = await stack.write.registerSource(broker, {
      kind: 'directory',
      location: '/tmp/unclaimed',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'unclaimed',
      sync: { enabled: false, strategy: 'manual' },
    });
    expect(rowTenant(String(a.id))).toBe(DEFAULT_TENANT_ID);

    // 显式 claim 'platform'：platform 公共库
    const b = await stack.write.registerSource({ ...broker, claimed: true, tenantId: PLATFORM_TENANT_ID }, {
      kind: 'directory',
      location: '/tmp/claimed-platform',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'claimed-platform',
      sync: { enabled: false, strategy: 'manual' },
    });
    expect(rowTenant(String(b.id))).toBe(PLATFORM_TENANT_ID);

    // 显式 claim 租户
    const c = await stack.write.registerSource({ ...broker, claimed: true, tenantId: 't-a' }, {
      kind: 'directory',
      location: '/tmp/claimed-a',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'claimed-a',
      sync: { enabled: false, strategy: 'manual' },
    });
    expect(rowTenant(String(c.id))).toBe('t-a');
  });

  it('写权限（MAJ-5）：租户身份不得改他域源；platform 运维豁免', async () => {
    const idB = await seedSource(stack, { tenantId: 't-b', gatewayId: 'gw' }, 'b-docs', 'bravo');
    // t-a 身份改 t-b 源 → 拒
    await expect(
      stack.write.updateSource({ tenantId: 't-a', gatewayId: 'gw' }, idB, {
        displayName: 'hijack',
      }),
    ).rejects.toMatchObject({ code: 'not_resource_owner' });
    await expect(
      stack.write.removeSource({ tenantId: 't-a', gatewayId: 'gw' }, idB),
    ).rejects.toMatchObject({ code: 'not_resource_owner' });
    // platform 运维豁免
    await expect(
      stack.write.updateSource({ tenantId: PLATFORM_TENANT_ID, gatewayId: 'gw' }, idB, {
        displayName: 'admin-rename',
      }),
    ).resolves.toBeTruthy();
    // 本域可写
    await expect(
      stack.write.removeSource({ tenantId: 't-b', gatewayId: 'gw' }, idB),
    ).resolves.toMatchObject({ id: idB });
  });

  it('租户断言（resolveTenantClaim）：platform token 任意断言；租户 token 限本域', () => {
    expect(resolveTenantClaim(PLATFORM_TENANT_ID, 't-a')).toEqual({ tenantId: 't-a' });
    expect(resolveTenantClaim('t-a', 't-a')).toEqual({ tenantId: 't-a' });
    expect(resolveTenantClaim('t-a', undefined)).toEqual({ tenantId: 't-a' });
    expect(resolveTenantClaim('t-a', 't-b')).toEqual({ error: 'tenant_mismatch' });
    expect(resolveTenantClaim(DEFAULT_TENANT_ID, 't-a')).toEqual({ error: 'tenant_mismatch' });
  });

  it('run 级 drill：两租户各跑 agent 调 knowledge_search，命中域 = 本域 ∪ platform', async () => {
    const idA = await seedSource(stack, { tenantId: 't-a', gatewayId: 'gw' }, 'a-docs', 'alpha');
    const idB = await seedSource(stack, { tenantId: 't-b', gatewayId: 'gw' }, 'b-docs', 'alpha');
    const idP = await seedSource(stack, { tenantId: PLATFORM_TENANT_ID, gatewayId: 'gw' }, 'p-docs', 'alpha');

    // 间谍包住真实检索：记录工具实际传入的租户断言 + 过滤后的命中域
    const searchCalls: Array<{ tenantId?: string; sourceIds: string[] }> = [];
    const originalSearch = stack.retriever.search.bind(stack.retriever);
    stack.retriever.search = (async (q: string, opts: Parameters<typeof originalSearch>[1]) => {
      const res = await originalSearch(q, opts);
      searchCalls.push({
        tenantId: (opts as { tenantId?: string }).tenantId,
        sourceIds: res.hits.map((h) => String(h.sourceId)).sort(),
      });
      return res;
    }) as typeof stack.retriever.search;

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

    async function runTenant(tenant: string): Promise<void> {
      const builder = new AgentBuilder()
        .model(scriptedProvider())
        .store(new InMemorySessionStore())
        .agentId(`agent-${tenant}`)
        .tenantId(tenant)
        .persona('hi');
      for (const tool of createKnowledgeTools({
        retriever: stack.retriever,
        indexStore: stack.index,
        sourceStore: stack.store,
      })) {
        builder.tool(tool);
      }
      const built = await builder.build();

      const sessionId = `kn:${tenant}`;
      const user: Message = { role: 'user', content: '搜一下', timestamp: Date.now() };
      for await (const ev of built.runner.handle(sessionId, user, {
        agentId: `agent-${tenant}`,
        sessionId,
        systemPrompt: '',
      })) {
        if (ev.type === 'engine.end' || ev.type === 'engine.error') break;
      }
    }

    await runTenant('t-a');
    await runTenant('t-b');

    const callA = searchCalls.find((c) => c.tenantId === 't-a');
    const callB = searchCalls.find((c) => c.tenantId === 't-b');
    // ① 归属锚：工具从 run scope 拿到的租户断言 = 各自租户
    expect(callA).toBeDefined();
    expect(callB).toBeDefined();
    // ② 命中域 = 本域 ∪ platform；互不出界
    expect(callA!.sourceIds).toEqual([idA, idP].sort());
    expect(callB!.sourceIds).toEqual([idB, idP].sort());
    expect(callA!.sourceIds).not.toContain(idB);
    expect(callB!.sourceIds).not.toContain(idA);
  }, 30_000);
});
