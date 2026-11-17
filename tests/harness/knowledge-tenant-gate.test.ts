/**
 * 租户闸单源性（arch/multi-tenancy.md §6；MAJ-4 控制面读口租户闸）
 *
 * 1. 等价性：tenantGate / ownerFunnel / projectGate 的内存判定与 SQL 谓词逐格一致
 *    （两形态是同一规则的两种表达；漂移 = 租户隔离被某条读路径悄悄破坏）。
 * 2. 回归：platform 域（broker，管理面无断言读身份）能看到 default 域项目与挂载
 *    （原缺陷：读身份 platform + 读路径硬等值 `tenant_id = ?` → 项目列表空）。
 * 3. 收紧：platform 项目仅 `visibility='public'` 跨域可见；挂载/overlay 不得绕过。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { PLATFORM_TENANT_ID } from '@octopi-agent/core/types.js';
import {
  ownerFunnelAllows,
  ownerFunnelSql,
  projectGateAllows,
  projectGateSql,
  tenantGateAllows,
  tenantGateSql,
  tenantOwnGateAllows,
  tenantOwnGateSql,
  type GateIdentity,
} from '@octopi-agent/engine/harness/knowledge/tenant-gate.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import {
  LocalKnowledgeWriteService,
  type WriteIdentity,
} from '@octopi-agent/engine/harness/knowledge/writer-service.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeRetriever } from '@octopi-agent/engine/harness/knowledge/retriever.js';
import { LocalKnowledgeQueryService } from '@octopi-agent/engine/harness/knowledge/query-service.js';

/** 用探针表验证 SQL 谓词：命中=true，未命中=false */
function sqlAllows(sql: string, params: string[], row: Record<string, string | null>): boolean {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE probe (tenant_id TEXT, registered_by TEXT, visibility TEXT)');
    db.prepare('INSERT INTO probe (tenant_id, registered_by, visibility) VALUES (?, ?, ?)').run(
      row.tenant_id,
      row.registered_by,
      row.visibility,
    );
    const hit = db
      .prepare(`SELECT 1 AS ok FROM probe WHERE ${sql}`)
      .get(...(params as never[])) as { ok?: number } | undefined;
    return Boolean(hit);
  } finally {
    db.close();
  }
}

const TENANTS = [undefined, '', 'default', PLATFORM_TENANT_ID, 't-a', 't-b'];
const IDENTITIES: Array<GateIdentity | undefined> = [
  undefined,
  {},
  { tenantId: 'default' },
  { tenantId: PLATFORM_TENANT_ID },
  { tenantId: 't-a' },
  { tenantId: 't-b', gatewayId: 'gw-b' },
];

describe('tenant-gate 等价性（内存判定 ≡ SQL 谓词）', () => {
  it('tenantGate：行归属 × 身份 逐格一致', () => {
    for (const rowTenant of TENANTS) {
      for (const identity of IDENTITIES) {
        const allowed = tenantGateAllows(rowTenant, identity);
        const { sql, params } = tenantGateSql('tenant_id', identity);
        expect(
          sqlAllows(sql, params, {
            tenant_id: rowTenant ?? null,
            registered_by: null,
            visibility: null,
          }),
          `tenantGate row=${String(rowTenant)} identity=${JSON.stringify(identity)}`,
        ).toBe(allowed);
      }
    }
  });

  it('ownerFunnel：登记网关 × 可见性 × 身份 逐格一致', () => {
    const registered = [undefined, '', 'gw-a', 'gw-b'];
    const visibilities = [undefined, '', 'public', 'private'];
    const identities: Array<GateIdentity | undefined> = [
      undefined,
      {},
      { gatewayId: 'gw-a' },
      { gatewayId: 'gw-b' },
    ];
    for (const reg of registered) {
      for (const vis of visibilities) {
        for (const identity of identities) {
          const allowed = ownerFunnelAllows(reg, vis, identity);
          const { sql, params } = ownerFunnelSql('registered_by', 'visibility', identity);
          expect(
            sqlAllows(sql, params, {
              tenant_id: null,
              registered_by: reg ?? null,
              visibility: vis ?? null,
            }),
            `ownerFunnel reg=${String(reg)} vis=${String(vis)} identity=${JSON.stringify(identity)}`,
          ).toBe(allowed);
        }
      }
    }
  });

  it('projectGate：行归属 × 可见性 × 身份 逐格一致', () => {
    const visibilities = [undefined, '', 'public', 'private'];
    for (const rowTenant of TENANTS) {
      for (const vis of visibilities) {
        for (const identity of IDENTITIES) {
          const allowed = projectGateAllows(rowTenant, vis, identity);
          const { sql, params } = projectGateSql('tenant_id', 'visibility', identity);
          expect(
            sqlAllows(sql, params, {
              tenant_id: rowTenant ?? null,
              registered_by: null,
              visibility: vis ?? null,
            }),
            `projectGate row=${String(rowTenant)} vis=${String(vis)} identity=${JSON.stringify(identity)}`,
          ).toBe(allowed);
        }
      }
    }
  });

  it('tenantOwnGate：行归属 × 身份 逐格一致（写入物本域隔离）', () => {
    for (const rowTenant of TENANTS) {
      for (const identity of IDENTITIES) {
        const allowed = tenantOwnGateAllows(rowTenant, identity);
        const { sql, params } = tenantOwnGateSql('tenant_id', identity);
        expect(
          sqlAllows(sql, params, {
            tenant_id: rowTenant ?? null,
            registered_by: null,
            visibility: null,
          }),
          `tenantOwnGate row=${String(rowTenant)} identity=${JSON.stringify(identity)}`,
        ).toBe(allowed);
      }
    }
  });
});

const gwLocal: WriteIdentity = { tenantId: 'default', gatewayId: 'gw-local' };
const broker: WriteIdentity = { tenantId: PLATFORM_TENANT_ID, gatewayId: 'gw-local' };
/** 显式 claim 'platform' 的写身份（registerSource 对无 claim 的 platform 写会降级 default） */
const brokerClaimed: WriteIdentity = { ...broker, claimed: true };

describe('tenant-gate 回归（管理面读身份 = platform 域）', () => {
  let stack: Awaited<ReturnType<typeof openStack>>;
  const openStack = async () => {
    const store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const db = store.database;
    const write = new LocalKnowledgeWriteService({ db });
    const index = new KnowledgeIndexStore(db);
    const retriever = new KnowledgeRetriever({ sourceStore: store, indexStore: index });
    const query = new LocalKnowledgeQueryService({
      db,
      sources: store,
      index,
      retriever,
      embeddingEnabled: false,
    });
    return { store, db, write, query };
  };

  afterEach(() => stack?.db.close());

  it('platform 身份看得到 default 域项目与挂载（原缺陷：项目列表空）', async () => {
    stack = await openStack();
    const { store, write, query } = stack;
    await write.createProject(gwLocal, { projectKey: 'docs', displayName: 'Docs' });
    await write.registerSource(gwLocal, {
      kind: 'directory',
      location: '/data/docs',
      scopeRef: { level: 'project', key: 'docs' },
      displayName: 'docs',
      visibility: 'private',
      sync: { enabled: false, strategy: 'manual' },
    });
    store.assignProject('docs', 'agent-a', gwLocal);

    const projects = (await query.listProjects(broker)) as Array<{
      projectKey: string;
      assignedAgentIds: string[];
    }>;
    expect(projects.map((p) => p.projectKey)).toContain('docs');
    expect(projects.find((p) => p.projectKey === 'docs')?.assignedAgentIds).toContain('agent-a');
    expect(store.listVisible('agent-a', undefined, broker)).toHaveLength(1);

    // 本域身份照常可见
    expect(
      ((await query.listProjects(gwLocal)) as Array<{ projectKey: string }>).map(
        (p) => p.projectKey,
      ),
    ).toContain('docs');

    // 跨租户仍然不可见（隔离不因修复而放松）
    const foreign: GateIdentity = { tenantId: 't-b', gatewayId: 'gw-local' };
    expect(
      ((await query.listProjects(foreign)) as Array<{ projectKey: string }>).map(
        (p) => p.projectKey,
      ),
    ).not.toContain('docs');
    expect(store.listVisible('agent-a', undefined, foreign)).toHaveLength(0);
  });

  it('收紧：platform 项目仅 public 跨域可见，且挂载/overlay 不得绕过', async () => {
    stack = await openStack();
    const { store, write, query } = stack;
    // 显式 claim 'platform'（WriteIdentity.claimed 语义）建平台域项目
    await write.createProject(brokerClaimed, {
      projectKey: 'pub',
      displayName: 'Pub',
      visibility: 'public',
    });
    await write.createProject(brokerClaimed, { projectKey: 'priv', displayName: 'Priv' });
    for (const key of ['pub', 'priv']) {
      await write.registerSource(brokerClaimed, {
        kind: 'directory',
        location: `/data/${key}`,
        scopeRef: { level: 'project', key },
        displayName: key,
        visibility: 'public',
        sync: { enabled: false, strategy: 'manual' },
      });
      // 跨域挂载（写侧另有 fail-loud 防线；这里压读侧收紧）
      store.assignProject(key, 'agent-a', gwLocal);
    }

    expect(
      ((await query.listProjects(gwLocal)) as Array<{ projectKey: string }>).map(
        (p) => p.projectKey,
      ),
    ).toEqual(['pub']);
    expect(
      ((await query.listProjects(broker)) as Array<{ projectKey: string }>)
        .map((p) => p.projectKey)
        .sort(),
    ).toEqual(['priv', 'pub']);

    // 挂载 grant 不得绕过项目跨域闸：priv 域下的源对 default 域不可见
    expect(store.listVisible('agent-a', undefined, gwLocal).map((s) => s.displayName)).toEqual([
      'pub',
    ]);
    expect(
      store
        .listVisible('agent-a', undefined, broker)
        .map((s) => s.displayName)
        .sort(),
    ).toEqual(['priv', 'pub']);
    // 控制面源列表同口径（domainVisible 亦走项目闸）
    expect((await query.listSources({ identity: gwLocal })).map((s) => s.displayName)).toEqual([
      'pub',
    ]);
    expect(
      (await query.listSources({ identity: broker }))
        .map((s) => s.displayName)
        .sort(),
    ).toEqual(['priv', 'pub']);
  });
});

describe('评审修复批（B1/M1/M3/M4）', () => {
  let stack: Awaited<ReturnType<typeof openStack>>;
  const openStack = async () => {
    const store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const db = store.database;
    const write = new LocalKnowledgeWriteService({ db });
    const index = new KnowledgeIndexStore(db);
    const retriever = new KnowledgeRetriever({ sourceStore: store, indexStore: index });
    const query = new LocalKnowledgeQueryService({
      db,
      sources: store,
      index,
      retriever,
      embeddingEnabled: false,
    });
    return { store, db, write, query };
  };

  afterEach(async () => {
    await stack?.db.close();
    stack = undefined as never;
  });

  it('B1：removeProject 只删调用方域内的行，跨域删除零伤害', async () => {
    stack = await openStack();
    await stack.write.createProject(brokerClaimed, {
      projectKey: 'shared',
      displayName: 'Shared',
      visibility: 'public',
    });
    await stack.write.createProject(gwLocal, { projectKey: 'shared', displayName: 'Mine' });

    // t-b 域写者删同名 key：其域内无行 → 不动 platform/default 的行
    await stack.write.removeProject({ tenantId: 't-b', gatewayId: 'gw-local' }, 'shared');
    expect(
      stack.db.raw
        .prepare("SELECT COUNT(*) AS n FROM knowledge_projects WHERE project_key = 'shared'")
        .get(),
    ).toEqual({ n: 2 });

    // 本域写者只删本域行
    const removed = await stack.write.removeProject(gwLocal, 'shared');
    expect(removed.removed).toBe(true);
    const rows = stack.db.raw
      .prepare("SELECT tenant_id FROM knowledge_projects WHERE project_key = 'shared'")
      .all() as Array<{ tenant_id: string }>;
    expect(rows.map((r) => r.tenant_id)).toEqual([PLATFORM_TENANT_ID]);
  });

  it('M1：project 域源继承项目行归属域后跨租户可见、可挂载', async () => {
    stack = await openStack();
    await stack.write.createProject(brokerClaimed, {
      projectKey: 'pub',
      displayName: 'Pub',
      visibility: 'public',
    });
    // 等价于 gateway 的域继承：getProject 解析出 platform 域 → 显式 claim platform 注册源
    const proj = stack.store.getProject('pub', gwLocal);
    expect(proj?.tenantId).toBe(PLATFORM_TENANT_ID);
    await stack.write.registerSource(
      { ...brokerClaimed, tenantId: proj!.tenantId },
      {
        kind: 'directory',
        location: '/data/pub',
        scopeRef: { level: 'project', key: 'pub' },
        displayName: 'pub-docs',
        visibility: 'public',
        sync: { enabled: false, strategy: 'manual' },
      },
    );

    const tB: WriteIdentity = { tenantId: 't-b', gatewayId: 'gw-local' };
    // t-b 把共享项目挂给自己的 agent（挂载行落 t-b 域）后可见
    stack.store.assignProject('pub', 'agent-tb', tB);
    const visible = stack.store.listVisible('agent-tb', undefined, tB);
    expect(visible.map((s) => s.displayName)).toEqual(['pub-docs']);
    expect(stack.store.listVisible('agent-tb', undefined, tB)).toHaveLength(1);
  });

  it('M3：同 key 跨域各一行时按域优先去重，计数/挂载不跨域混计', async () => {
    stack = await openStack();
    await stack.write.createProject(brokerClaimed, {
      projectKey: 'dup',
      displayName: 'Platform row',
      visibility: 'public',
    });
    await stack.write.registerSource(brokerClaimed, {
      kind: 'directory',
      location: '/data/dup-p',
      scopeRef: { level: 'project', key: 'dup' },
      displayName: 'dup-p',
      visibility: 'public',
      sync: { enabled: false, strategy: 'manual' },
    });
    await stack.write.createProject(gwLocal, { projectKey: 'dup', displayName: 'My row' });
    await stack.write.registerSource(gwLocal, {
      kind: 'directory',
      location: '/data/dup-d',
      scopeRef: { level: 'project', key: 'dup' },
      displayName: 'dup-d',
      visibility: 'private',
      sync: { enabled: false, strategy: 'manual' },
    });
    stack.store.assignProject('dup', 'agent-a', gwLocal);

    const own = stack.store.listProjects(gwLocal);
    expect(own).toHaveLength(1);
    expect(own[0].tenantId).toBe('default');
    expect(own[0].displayName).toBe('My row');
    expect(own[0].sourceCount).toBe(1); // 只计本域行的源
    expect(own[0].assignedAgentIds).toEqual(['agent-a']); // 读方自己的挂载照常显示

    const all = stack.store.listProjects(broker);
    expect(all).toHaveLength(1);
    expect(all[0].tenantId).toBe(PLATFORM_TENANT_ID);
  });

  it('M4：platform 覆盖行不扩散到租户 agent；同键多行本域优先确定性', async () => {
    stack = await openStack();
    const { store, write } = stack;
    const created = await write.registerSource(brokerClaimed, {
      kind: 'directory',
      location: '/data/x',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'x',
      visibility: 'public',
      sync: { enabled: false, strategy: 'manual' },
    });
    const sourceId = created.id;
    // platform 域 exclude 行（broker 写）——不得影响 default 域 agent-a
    store.hideSource('agent-a', sourceId, brokerClaimed);
    expect(store.listVisible('agent-a', undefined, gwLocal)).toHaveLength(1);

    // 同 (gateway, agent, source) 两域各一行：本域行优先（include 胜过 platform 的 exclude）
    store.mountSource('agent-a', sourceId, gwLocal);
    expect(store.listVisible('agent-a', undefined, gwLocal)).toHaveLength(1);
    // platform 身份（broker 运维面）：platform 行=本域行优先 → exclude 生效，判定确定不漂移
    expect(store.listVisible('agent-a', undefined, broker)).toHaveLength(0);
  });
});

describe('m6/m7：项目行缓存等价 + 统计本视图口径（拍板 B）', () => {
  const openStack = async () => {
    const store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const db = store.database;
    const write = new LocalKnowledgeWriteService({ db });
    const index = new KnowledgeIndexStore(db);
    const retriever = new KnowledgeRetriever({ sourceStore: store, indexStore: index });
    const query = new LocalKnowledgeQueryService({
      db,
      sources: store,
      index,
      retriever,
      embeddingEnabled: false,
    });
    return { store, db, write, query };
  };

  it('m6：项目行批处理缓存与单查逐格一致；idx_knowledge_projects_key 已建', async () => {
    const stack = await openStack();
    await stack.write.createProject(brokerClaimed, {
      projectKey: 'pub',
      displayName: 'Pub',
      visibility: 'public',
    });
    await stack.write.createProject(brokerClaimed, { projectKey: 'priv', displayName: 'Priv' });
    const identities: Array<WriteIdentity> = [gwLocal, broker, { tenantId: 't-b', gatewayId: 'gw-local' }];
    for (const identity of identities) {
      const uncached = ['pub', 'priv'].map((k) => stack.store.isProjectVisibleTo(k, identity));
      const cached = stack.store.withProjectRowCache(() =>
        ['pub', 'priv'].map((k) => stack.store.isProjectVisibleTo(k, identity)),
      );
      expect(cached, `m6 cache equivalence identity=${JSON.stringify(identity)}`).toEqual(uncached);
    }
    const idx = stack.db.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_knowledge_projects_key'",
      )
      .get();
    expect(idx, 'idx_knowledge_projects_key must exist').toBeTruthy();
    stack.db.close();
  });

  it('m7：principalStats 只数可见源（隐藏/他域不计入），可见性计数器同口径', async () => {
    const stack = await openStack();
    const s1 = await stack.write.registerSource(gwLocal, {
      kind: 'directory',
      location: '/data/m7-a',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'm7-a',
      visibility: 'public',
      sync: { enabled: false, strategy: 'manual' },
    });
    const s2 = await stack.write.registerSource(gwLocal, {
      kind: 'directory',
      location: '/data/m7-b',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'm7-b',
      visibility: 'public',
      sync: { enabled: false, strategy: 'manual' },
    });
    stack.store.hideSource('agent-a', s2.id, gwLocal);

    const stats = await stack.query.principalStats('agent-a', gwLocal);
    expect(stats.stats.sources).toBe(1);
    expect(stats.visibleSources).toBe(1);
    expect(stats.stats.agentHidden).toBe(1);

    const foreign = await stack.query.principalStats('agent-a', {
      tenantId: 't-b',
      gatewayId: 'gw-local',
    });
    expect(foreign.stats.sources).toBe(0);
    expect(foreign.visibleSources).toBe(0);
    void s1;
    stack.db.close();
  });
});
