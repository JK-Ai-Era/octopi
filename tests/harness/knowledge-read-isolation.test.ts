/**
 * 纯读直达 Query Worker — 路由分类 + 源详情只读拼装
 *
 * 验证：isPureReadRoute 覆盖 UI 列表/详情；getSourceDetail 不依赖 ingest 内存态。
 */
import { describe, expect, it } from 'vitest';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeRetriever } from '@octopi-agent/engine/harness/knowledge/retriever.js';
import { LocalKnowledgeQueryService } from '@octopi-agent/engine/harness/knowledge/query-service.js';
import { isPureReadRoute } from '@octopi-agent/engine/harness/knowledge/read-http.js';
import { readJobControlState } from '@octopi-agent/engine/harness/knowledge/job-control-state.js';

describe('knowledge pure-read routing', () => {
  it('covers list/detail/jobs/search reads; mutations stay on Engine', () => {
    expect(isPureReadRoute('GET', '/v1/projects')).toBe(true);
    expect(isPureReadRoute('GET', '/v1/sources')).toBe(true);
    expect(isPureReadRoute('GET', '/v1/sources/ks_1')).toBe(true);
    expect(isPureReadRoute('GET', '/v1/sources/ks_1/files')).toBe(true);
    expect(isPureReadRoute('GET', '/v1/jobs')).toBe(true);
    expect(isPureReadRoute('GET', '/v1/jobs/control')).toBe(true);
    expect(isPureReadRoute('GET', '/v1/principals/a1/catalog')).toBe(true);
    expect(isPureReadRoute('POST', '/v1/principals/a1/read')).toBe(true);
    expect(isPureReadRoute('GET', '/v1/ready')).toBe(true);

    expect(isPureReadRoute('POST', '/v1/sources')).toBe(false);
    expect(isPureReadRoute('DELETE', '/v1/sources/ks_1')).toBe(false);
    expect(isPureReadRoute('GET', '/v1/events')).toBe(false);
    expect(isPureReadRoute('POST', '/v1/jobs/abort')).toBe(false);
    expect(isPureReadRoute('PATCH', '/v1/sources/ks_1')).toBe(false);
  });

  it('getSourceDetail + jobControlState 为纯 SQL（无 ingest）', async () => {
    const store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const db = store.database;
    const index = new KnowledgeIndexStore(db);
    const retriever = new KnowledgeRetriever({ sourceStore: store, indexStore: index });
    const svc = new LocalKnowledgeQueryService({
      db,
      sources: store,
      index,
      retriever,
      embeddingEnabled: true,
    });

    store.createProject('p1', 'Proj', { tenantId: 'default', gatewayId: 'default' });
    const src = store.register({
      kind: 'directory',
      location: '/data/docs',
      scopeRef: { level: 'project', key: 'p1' },
      displayName: 'src',
    });
    store.assignProject('p1', 'agent-a', { tenantId: 'default', gatewayId: 'default' });

    const detail = await svc.getSourceDetail(src.id, {
      tenantId: 'default',
      gatewayId: 'default',
    });
    expect(detail).not.toBeNull();
    expect(detail!.source.id).toBe(src.id);
    expect(detail!.assignedAgentIds).toContain('agent-a');
    expect(detail!.jobControl).toMatchObject({
      aborted: false,
      jobsQueued: 0,
      jobsRunning: 0,
    });

    const state = readJobControlState(db, index, src.id, { embeddingEnabled: true });
    expect(state.canAbort).toBe(false);
    expect(state.canResume).toBe(false);

    const projects = await svc.listProjects({ tenantId: 'default', gatewayId: 'default' });
    expect(projects.find((p) => p.projectKey === 'p1')?.assignedAgentIds).toEqual(['agent-a']);

    db.close();
  });
});
