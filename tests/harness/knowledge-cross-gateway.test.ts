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
});
