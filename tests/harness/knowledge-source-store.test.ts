/**
 * KnowledgeSourceStore — 注册 / 可见性 / catalog（arch/knowledge-layer.md §1.3）
 */

import { describe, it, expect, afterEach } from 'vitest';
import { KnowledgeSourceStore } from '../../src/harness/knowledge/source-store.js';
import {
  generateKnowledgeDescription,
  heuristicDescription,
} from '../../src/harness/knowledge/describe.js';
import { scanSecretShapes } from '../../src/harness/knowledge/secret-scan.js';

async function openStore(): Promise<KnowledgeSourceStore> {
  return KnowledgeSourceStore.open({ dbPath: ':memory:' });
}

describe('KnowledgeSourceStore', () => {
  let store: KnowledgeSourceStore;

  afterEach(() => {
    store?.database.close();
  });

  it('register + get + update + remove', async () => {
    store = await openStore();
    const src = store.register({
      kind: 'directory',
      location: '/data/docs',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'company-docs',
      description: '公共文档',
    });
    expect(src.id).toBeTruthy();
    expect(store.get(src.id)?.displayName).toBe('company-docs');

    const updated = store.update(src.id, { displayName: 'handbook', status: 'ready' });
    expect(updated?.displayName).toBe('handbook');
    expect(updated?.status).toBe('ready');

    expect(store.remove(src.id)).toBe(true);
    expect(store.get(src.id)).toBeNull();
  });

  it('Global 默认可见，可 hide', async () => {
    store = await openStore();
    const g = store.register({
      kind: 'directory',
      location: '/g',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'g',
    });
    expect(store.isVisible(g, 'a1')).toBe(true);
    store.hideSource('a1', g.id);
    expect(store.isVisible(g, 'a1')).toBe(false);
    expect(store.isVisible(g, 'a2')).toBe(true);
    store.unhideSource('a1', g.id);
    expect(store.isVisible(g, 'a1')).toBe(true);
  });

  it('Project 显式挂载，未挂不可见', async () => {
    store = await openStore();
    const p = store.register({
      kind: 'directory',
      location: '/proj',
      scopeRef: { level: 'project', key: 'proj-alpha' },
      displayName: 'proj-alpha',
    });
    expect(store.isVisible(p, 'a1')).toBe(false);
    store.assignProject('proj-alpha', 'a1');
    expect(store.isVisible(p, 'a1')).toBe(true);
    expect(store.isVisible(p, 'a2')).toBe(false);
    store.unassignProject('proj-alpha', 'a1');
    expect(store.isVisible(p, 'a1')).toBe(false);
  });

  it('Session 源仅本会话可见', async () => {
    store = await openStore();
    const s = store.register({
      kind: 'file',
      location: '/tmp/a.pdf',
      scopeRef: { level: 'session', key: 'sess-1' },
      displayName: 'attach',
    });
    expect(store.isVisible(s, 'a1', 'sess-1')).toBe(true);
    expect(store.isVisible(s, 'a1', 'sess-2')).toBe(false);
    expect(store.isVisible(s, 'a1')).toBe(false);
  });

  it('catalogFor 过滤 + 排序 + fingerprint 稳定', async () => {
    store = await openStore();
    store.register({
      kind: 'directory',
      location: '/g1',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'aaa',
      catalogPriority: 1,
      status: 'ready',
    });
    store.register({
      kind: 'directory',
      location: '/p1',
      scopeRef: { level: 'project', key: 'p' },
      displayName: 'bbb',
      catalogPriority: 10,
    });
    store.assignProject('p', 'a1');

    const items = store.catalogFor('a1');
    expect(items.map((i) => i.displayName)).toEqual(['bbb', 'aaa']);
    expect(items[0].status).toBe('pending');

    const fp1 = store.catalogFingerprint('a1');
    const fp2 = store.catalogFingerprint('a1');
    expect(fp1).toBe(fp2);

    store.update(items[0].id, { status: 'ready' });
    // status 桶变 → fingerprint 变
    expect(store.catalogFingerprint('a1')).not.toBe(fp1);
  });

  it('hiddenFromCatalog 参与检索可见但不进 catalog', async () => {
    store = await openStore();
    const src = store.register({
      kind: 'file',
      location: '/x',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'x',
      hiddenFromCatalog: true,
    });
    expect(store.listVisible('a1').some((s) => s.id === src.id)).toBe(true);
    expect(store.catalogFor('a1').some((s) => s.id === src.id)).toBe(false);
  });

  it('disabled / removed 不可见', async () => {
    store = await openStore();
    const src = store.register({
      kind: 'file',
      location: '/x',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'x',
    });
    store.update(src.id, { status: 'disabled' });
    expect(store.isVisible(store.get(src.id)!, 'a1')).toBe(false);
  });
});

describe('auto-describe + secret scan', () => {
  it('命中密钥形态时禁止外发 LLM', async () => {
    const result = await generateKnowledgeDescription(
      { displayName: 'cfg', kind: 'file', location: '/cfg' },
      'api_key = "sk-abcdefghijklmnopqrstuvwxyz123456"',
      {
        describePort: async () => 'should not be called',
      },
    );
    expect(result.source).toBe('blocked_secret');
    expect(result.secretHits?.length).toBeGreaterThan(0);
    expect(result.description).toBe(
      heuristicDescription({ displayName: 'cfg', kind: 'file', location: '/cfg' }),
    );
  });

  it('无端口时启发式；enabled=false 不调用 LLM', async () => {
    let called = 0;
    const port = async () => {
      called += 1;
      return 'LLM 描述';
    };
    const a = await generateKnowledgeDescription(
      { displayName: 'a', kind: 'directory', location: '/a' },
      'plain tree',
      { describePort: port, enabled: false },
    );
    expect(a.source).toBe('disabled');
    expect(called).toBe(0);

    const b = await generateKnowledgeDescription(
      { displayName: 'a', kind: 'directory', location: '/a' },
      'plain tree',
      { describePort: port },
    );
    expect(b.source).toBe('llm');
    expect(b.description).toBe('LLM 描述');
    expect(called).toBe(1);
  });

  it('scanSecretShapes 只报形态', () => {
    expect(scanSecretShapes('hello')).toEqual([]);
    expect(scanSecretShapes('-----BEGIN PRIVATE KEY-----').length).toBeGreaterThan(0);
  });
});
