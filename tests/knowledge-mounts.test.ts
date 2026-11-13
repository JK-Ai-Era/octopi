/**
 * T3b 挂载物化 + 控制面读口闸（arch/multi-tenancy.md §6：命中 = 挂载库 ∪ 本租户公共 ∪ platform 公共）。
 *
 * - 挂载（agent 级 include）覆盖基础可见性；卸载回基础；hide/mount 单 op 翻转
 * - knowledge_agent_hidden → knowledge_agent_visibility 迁移保留旧行（op=exclude）
 * - 控制面读口（query-service）按租户收口（评审 MAJ-4）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_TENANT_ID, PLATFORM_TENANT_ID } from '@octopi-agent/core/types.js';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeRetriever } from '@octopi-agent/engine/harness/knowledge/retriever.js';
import { LocalKnowledgeQueryService } from '@octopi-agent/engine/harness/knowledge/query-service.js';
import type { KnowledgeSourceInput } from '@octopi-agent/engine/harness/knowledge/types.js';

interface Stack {
  db: KnowledgeDatabase;
  store: KnowledgeSourceStore;
  retriever: KnowledgeRetriever;
  query: LocalKnowledgeQueryService;
}

async function openStack(): Promise<Stack> {
  const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
  const store = new KnowledgeSourceStore(db);
  const index = new KnowledgeIndexStore(db);
  const retriever = new KnowledgeRetriever({ sourceStore: store, indexStore: index });
  const query = new LocalKnowledgeQueryService({
    db,
    sources: store,
    index,
    retriever,
    embeddingEnabled: false,
  });
  return { db, store, retriever, query };
}

function rowTenant(stack: Stack, id: string): string {
  return (
    stack.db.raw.prepare('SELECT tenant_id FROM knowledge_sources WHERE id = ?').get(id) as {
      tenant_id: string;
    }
  ).tenant_id;
}

/** 写一条源并打租户（走 store.register + 租户列，模拟受管注册） */
function seed(
  stack: Stack,
  opts: {
    tenantId: string;
    name: string;
    scopeRef?: { level: 'global' | 'project' | 'session'; key: string };
  },
): string {
  const input: KnowledgeSourceInput = {
    kind: 'directory',
    location: `/tmp/${opts.name}`,
    scopeRef: opts.scopeRef ?? { level: 'global', key: 'global' },
    displayName: opts.name,
    sync: { enabled: false, strategy: 'manual' },
  };
  const src = stack.store.register(input);
  stack.db.raw
    .prepare('UPDATE knowledge_sources SET tenant_id = ?, registered_by = ? WHERE id = ?')
    .run(opts.tenantId, ID.gatewayId, src.id);
  return String(src.id);
}

const ID = { tenantId: 't-a', gatewayId: 'gw' };

describe('T3b 挂载物化', () => {
  let stack: Stack;
  beforeEach(async () => {
    stack = await openStack();
  });
  afterEach(() => stack.db.close());

  it('挂载覆盖基础可见性：私有源 mount 后可见、unmount 回不可见', () => {
    // scopeRef=session 源：无挂载时 agent 不可见（基础语义）
    const id = seed(stack, {
      tenantId: 't-a',
      name: 'private-docs',
      scopeRef: { level: 'session', key: 'sess-1' },
    });
    const src = stack.store.get(id)!;

    expect(stack.store.isBaseVisible(src, 'agent-1', undefined, ID)).toBe(false);
    expect(stack.retriever.visibleSourceIds('agent-1', undefined, ID)).not.toContain(id as never);

    stack.store.mountSource('agent-1', id, ID);
    expect(stack.store.isBaseVisible(src, 'agent-1', undefined, ID)).toBe(true);
    expect(stack.retriever.visibleSourceIds('agent-1', undefined, ID)).toContain(id as never);

    stack.store.unmountSource('agent-1', id, ID);
    expect(stack.store.isBaseVisible(src, 'agent-1', undefined, ID)).toBe(false);
  });

  it('hide/mount 单 op 翻转（一表两向，无双表优先级歧义）', () => {
    const id = seed(stack, { tenantId: 't-a', name: 'global-docs' });
    const src = stack.store.get(id)!;
    expect(stack.store.isBaseVisible(src, 'agent-1', undefined, ID)).toBe(true);

    stack.store.hideSource('agent-1', id, ID);
    expect(stack.store.isBaseVisible(src, 'agent-1', undefined, ID)).toBe(false);

    // mount 翻转 hide
    stack.store.mountSource('agent-1', id, ID);
    expect(stack.store.isBaseVisible(src, 'agent-1', undefined, ID)).toBe(true);

    // hide 翻转 mount
    stack.store.hideSource('agent-1', id, ID);
    expect(stack.store.isBaseVisible(src, 'agent-1', undefined, ID)).toBe(false);

    // unhide 只撤 exclude → 回基础（global 可见）
    stack.store.unhideSource('agent-1', id, ID);
    expect(stack.store.isBaseVisible(src, 'agent-1', undefined, ID)).toBe(true);
  });

  it('挂载不出租户（§6）：租户闸仍在挂载之上', () => {
    // t-b 私有源挂到 agent（include 行），t-a 的 run 仍不可见
    const idB = seed(stack, { tenantId: 't-b', name: 'b-private', scopeRef: { level: 'session', key: 's' } });
    stack.store.mountSource('agent-1', idB, ID); // include 行落 t-a 域

    // t-a 域检索（agent 挂载在场）——租户闸拒绝 t-b 私有源
    expect(stack.retriever.visibleSourceIds('agent-1', undefined, ID)).not.toContain(idB as never);
    // 挂载行本身存在（定义面语义已在 registry 侧；这里验证执法面不越界）
    expect(stack.store.listMounted('agent-1', ID)).toContain(idB);
  });

  it('迁移：knowledge_agent_hidden 旧行以 op=exclude 迁入 visibility（隐藏语义保留）', async () => {
    // 手工造 v1 隐藏表 + 行，再走 db.open 迁移
    const dir = mkdtempSync(join(tmpdir(), 'kn-vis-mig-'));
    const dbPath = join(dir, 'knowledge.db');
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const raw = new DatabaseSync(dbPath);
      raw.exec(`
        CREATE TABLE knowledge_agent_hidden (
          tenant_id TEXT NOT NULL DEFAULT 'default',
          gateway_id TEXT NOT NULL DEFAULT 'default',
          local_agent_id TEXT NOT NULL DEFAULT '',
          source_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, gateway_id, local_agent_id, source_id)
        );
        INSERT INTO knowledge_agent_hidden VALUES ('default', 'gw', 'agent-x', 'ks_old', 1);
      `);
      raw.close();

      const db = await KnowledgeDatabase.create({ dbPath });
      try {
        const rows = db.raw
          .prepare('SELECT * FROM knowledge_agent_visibility')
          .all() as Array<{ local_agent_id: string; source_id: string; op: string }>;
        expect(rows).toEqual([
          { tenant_id: 'default', gateway_id: 'gw', local_agent_id: 'agent-x', source_id: 'ks_old', op: 'exclude', created_at: 1 },
        ]);
        const legacy = db.raw
          .prepare(`SELECT name FROM sqlite_master WHERE name = 'knowledge_agent_hidden'`)
          .get();
        expect(legacy).toBeUndefined();
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('T3b 控制面读口闸（评审 MAJ-4）', () => {
  let stack: Stack;
  beforeEach(async () => {
    stack = await openStack();
  });
  afterEach(() => stack.db.close());

  it('listSources/getSource/listFiles 跨租户读不到', async () => {
    const idB = seed(stack, { tenantId: 't-b', name: 'b-docs' });
    const idP = seed(stack, { tenantId: PLATFORM_TENANT_ID, name: 'p-docs' });

    const tA = { tenantId: 't-a', gatewayId: 'gw' };
    const listed = await stack.query.listSources({ identity: tA });
    const ids = listed.map((s) => String(s.id));
    expect(ids).not.toContain(idB);
    expect(ids).toContain(idP);

    expect(await stack.query.getSource(idB, tA)).toBeNull();
    expect(await stack.query.getSource(idP, tA)).not.toBeNull();

    expect(await stack.query.listFiles(idB, tA)).toEqual([]);
  });

  it('platform 身份 = 运维面全量；无身份 = 宿主面', async () => {
    const idB = seed(stack, { tenantId: 't-b', name: 'b-docs' });
    const broker = { tenantId: PLATFORM_TENANT_ID, gatewayId: 'gw' };
    const listed = await stack.query.listSources({ identity: broker });
    expect(listed.map((s) => String(s.id))).toContain(idB);

    const hostPlane = await stack.query.listSources({});
    expect(hostPlane.map((s) => String(s.id))).toContain(idB);
  });

  it('无归属 identity = DEFAULT 域（fail-closed，与检索口径一致）', async () => {
    const idB = seed(stack, { tenantId: 't-b', name: 'b-docs' });
    const idLegacy = seed(stack, { tenantId: DEFAULT_TENANT_ID, name: 'legacy' });
    const listed = await stack.query.listSources({ identity: { gatewayId: 'gw' } });
    const ids = listed.map((s) => String(s.id));
    expect(ids).toContain(idLegacy);
    expect(ids).not.toContain(idB);
  });
});
