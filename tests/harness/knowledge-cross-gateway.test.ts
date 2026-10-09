/**
 * 跨 Gateway 隔离回归 — session-visibility / principal 归属 / 删源停 ingest
 *
 * 审查曾指出：assertOwnPrincipal 空转、session-visibility 只按 sessionId、
 * removeSource 不 abort。本文件钉死修复后的行为。
 */
import { describe, expect, it } from 'vitest';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { LocalKnowledgeWriteService } from '@octopi-agent/engine/harness/knowledge/writer-service.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeRetriever } from '@octopi-agent/engine/harness/knowledge/retriever.js';
import { LocalKnowledgeQueryService } from '@octopi-agent/engine/harness/knowledge/query-service.js';

const gwA = { tenantId: 'acme', gatewayId: 'gw-a' };
const gwB = { tenantId: 'acme', gatewayId: 'gw-b' };

async function openStack() {
  const store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
  const db = store.database;
  const write = new LocalKnowledgeWriteService({ db });
  const index = new KnowledgeIndexStore(db);
  const retriever = new KnowledgeRetriever({
    sourceStore: store,
    indexStore: index,
  });
  const query = new LocalKnowledgeQueryService({
    db,
    sources: store,
    index,
    retriever,
    embeddingEnabled: false,
  });
  return { store, db, write, query };
}

describe('cross-gateway isolation', () => {
  it('session-visibility 按 tenant/gateway 隔离，不清不读他方行', async () => {
    const { store, write, query, db } = await openStack();
    // public + 正确 tenant：两 gateway 都能看到 base，才能单独测 overlay 隔离
    const created = await write.registerSource(gwA, {
      kind: 'directory',
      location: '/tmp/shared',
      scopeRef: { level: 'project', key: 'api' },
      displayName: 'API',
      visibility: 'public',
      sync: { enabled: false, strategy: 'manual' },
    });
    const src = store.get(created.id)!;
    store.assignProject('api', 'coder', gwA);
    store.assignProject('api', 'coder', gwB);

    await write.replaceSessionVisibility(gwA, 'coder', 'sess-1', [
      { targetType: 'project', targetId: 'api', op: 'exclude' },
    ]);

    // A 的会话 exclude 生效
    expect(store.isVisible(src, 'coder', 'sess-1', gwA)).toBe(false);
    // B 同 sessionId 不受 A 的 overlay 影响
    expect(store.isVisible(src, 'coder', 'sess-1', gwB)).toBe(true);

    const listA = await query.sessionVisibility('coder', 'sess-1', gwA);
    expect(listA).toHaveLength(1);
    const listB = await query.sessionVisibility('coder', 'sess-1', gwB);
    expect(listB).toHaveLength(0);

    // B clear 不得清掉 A 的行
    await write.clearSessionVisibility(gwB, 'sess-1');
    expect((await query.sessionVisibility('coder', 'sess-1', gwA))).toHaveLength(1);

    db.close();
  });

  it('assertOwnPrincipal 拒绝他方已登记的同名 principal', async () => {
    const { write, db } = await openStack();
    await write.upsertPrincipal(gwA, 'coder', {});
    await expect(write.assertOwnPrincipal(gwA, 'coder')).resolves.toBeUndefined();
    await expect(write.assertOwnPrincipal(gwB, 'coder')).rejects.toMatchObject({
      code: 'not_principal_owner',
    });
    // 未登记名：允许（autoRegister 负责落库）
    await expect(write.assertOwnPrincipal(gwB, 'other')).resolves.toBeUndefined();
    db.close();
  });

  it('isPrincipalForeign 只读闸门与 assertOwnPrincipal 同口径', async () => {
    const { write, query, db } = await openStack();
    await write.upsertPrincipal(gwA, 'coder', {});
    expect(await query.isPrincipalForeign(gwA, 'coder')).toBe(false);
    expect(await query.isPrincipalForeign(gwB, 'coder')).toBe(true);
    expect(await query.isPrincipalForeign(gwB, 'nobody')).toBe(false);
    db.close();
  });

  it('removeSource 先 abort，防止 purge 让出窗口写回孤儿', async () => {
    const { write, store, db } = await openStack();
    const src = await write.registerSource(gwA, {
      kind: 'directory',
      location: '/tmp/docs-del',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'del',
      sync: { enabled: false, strategy: 'manual' },
    });

    const res = await write.removeSource(gwA, src.id);
    expect(res.id).toBe(src.id);
    expect(store.get(src.id)).toBeNull();
    // 删源必须留下中止纪元，防止在途 parse 写回
    expect(write.ingest.jobControlState(src.id).aborted).toBe(true);
    db.close();
  });

  it('progress 事件自带 registeredBy/visibility，SSE 可本地过滤', async () => {
    const { write, db } = await openStack();
    const src = await write.registerSource(gwA, {
      kind: 'directory',
      location: '/tmp/docs-prog',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'prog',
      visibility: 'private',
      sync: { enabled: false, strategy: 'manual' },
    });
    const events: Array<Record<string, unknown>> = [];
    const off = write.onProgress((e) => events.push(e as unknown as Record<string, unknown>));
    // abort 必发 progress，且 emitProgress 补齐归属字段
    write.ingest.abortJobs({ sourceId: src.id });
    off();
    const withSrc = events.filter((e) => e.sourceId === src.id);
    expect(withSrc.length).toBeGreaterThan(0);
    for (const e of withSrc) {
      expect(e.registeredBy).toBe('gw-a');
      expect(e.visibility).toBe('private');
    }
    db.close();
  });

  it('catalog/挂载同口径：他方 gateway 的 project 挂载不得进 catalog', async () => {
    const { store, write, query, db } = await openStack();
    await write.registerSource(gwA, {
      kind: 'directory',
      location: '/tmp/docs-cat',
      scopeRef: { level: 'project', key: 'docs' },
      displayName: 'docs',
      visibility: 'public',
      sync: { enabled: false, strategy: 'manual' },
    });

    // 只挂在 gw-b / coder；gw-a 同名 agent 不得看见
    store.assignProject('docs', 'coder', gwB);

    expect(store.catalogFor('coder', { identity: gwB }).map((i) => i.displayName)).toEqual([
      'docs',
    ]);
    expect(store.catalogFor('coder', { identity: gwA })).toEqual([]);
    expect(await query.catalog('coder', gwB)).toHaveLength(1);
    expect(await query.catalog('coder', gwA)).toHaveLength(0);
    expect((await query.visibility('coder', gwB)).assignedProjects).toContain('docs');
    expect((await query.visibility('coder', gwA)).assignedProjects).not.toContain('docs');
    db.close();
  });

  it('catalog 不得误命中 gateway_id=default 的脏挂载行（运行时 identity=gw-local）', async () => {
    const { store, write, query, db } = await openStack();
    await write.registerSource(gwA, {
      kind: 'directory',
      location: '/tmp/docs-orphan',
      scopeRef: { level: 'project', key: 'orphan' },
      displayName: 'orphan',
      visibility: 'public',
      sync: { enabled: false, strategy: 'manual' },
    });

    // 模拟历史脏数据：挂载行落在 gateway_id=default，运行时 principal 却是 gw-local
    store.assignProject('orphan', 'default', {
      tenantId: 'acme',
      gatewayId: 'default',
    });

    const runtime = { tenantId: 'acme', gatewayId: 'gw-local' };
    expect(store.catalogFor('default', { identity: runtime })).toEqual([]);
    expect(await query.catalog('default', runtime)).toHaveLength(0);
    expect((await query.visibility('default', runtime)).assignedProjects).toEqual([]);
    // 同一挂载行对 default 口径仍可见（非跨 gateway 泄漏）
    expect(
      store.catalogFor('default', { identity: { tenantId: 'acme', gatewayId: 'default' } }),
    ).toHaveLength(1);
    db.close();
  });
});
