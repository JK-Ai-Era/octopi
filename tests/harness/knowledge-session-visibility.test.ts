/**
 * Session visibility overlay — 会话视图不改资产归属
 * 规格：arch/knowledge-admin-ui.md §1
 */
import { describe, expect, it } from 'vitest';
import { KnowledgeSourceStore } from '../../src/harness/knowledge/source-store.js';

async function openStore(): Promise<KnowledgeSourceStore> {
  return KnowledgeSourceStore.open({ dbPath: ':memory:' });
}

describe('session visibility overlay', () => {
  it('include project 仅本会话可见，不改 agent 挂载', async () => {
    const store = await openStore();
    const src = store.register({
      kind: 'directory',
      location: '/tmp/api-docs',
      scopeRef: { level: 'project', key: 'api-docs' },
      displayName: 'API Docs',
    });

    expect(store.isVisible(src, 'coder')).toBe(false);
    expect(store.isVisible(src, 'coder', 'sess-1')).toBe(false);

    store.setSessionVisibility('sess-1', {
      targetType: 'project',
      targetId: 'api-docs',
      op: 'include',
    });

    expect(store.isVisible(src, 'coder', 'sess-1')).toBe(true);
    expect(store.isVisible(src, 'coder', 'sess-2')).toBe(false);
    expect(store.isVisible(src, 'coder')).toBe(false);
    expect(store.listProjectAgents('api-docs')).toEqual([]);
    expect(store.listBaseVisible('coder', 'sess-1')).toHaveLength(0);
    expect(store.listVisible('coder', 'sess-1')).toHaveLength(1);
  });

  it('exclude project 仅本会话隐藏已挂载项目', async () => {
    const store = await openStore();
    const src = store.register({
      kind: 'directory',
      location: '/tmp/specs',
      scopeRef: { level: 'project', key: 'specs' },
      displayName: 'Specs',
    });
    store.assignProject('specs', 'coder');

    expect(store.isVisible(src, 'coder', 'sess-1')).toBe(true);

    store.setSessionVisibility('sess-1', {
      targetType: 'project',
      targetId: 'specs',
      op: 'exclude',
    });

    expect(store.isVisible(src, 'coder', 'sess-1')).toBe(false);
    expect(store.isVisible(src, 'coder', 'sess-2')).toBe(true);
    expect(store.listBaseVisible('coder', 'sess-1')).toHaveLength(1);
  });

  it('source 级 overlay 优先于 project 级', async () => {
    const store = await openStore();
    const a = store.register({
      kind: 'file',
      location: '/tmp/specs/a.md',
      scopeRef: { level: 'project', key: 'specs' },
      displayName: 'A',
    });
    const b = store.register({
      kind: 'file',
      location: '/tmp/specs/b.md',
      scopeRef: { level: 'project', key: 'specs' },
      displayName: 'B',
    });
    store.assignProject('specs', 'coder');
    store.setSessionVisibility('sess-1', {
      targetType: 'project',
      targetId: 'specs',
      op: 'exclude',
    });
    store.setSessionVisibility('sess-1', {
      targetType: 'source',
      targetId: a.id,
      op: 'include',
    });

    expect(store.isVisible(a, 'coder', 'sess-1')).toBe(true);
    expect(store.isVisible(b, 'coder', 'sess-1')).toBe(false);
    expect(store.isVisible(a, 'coder', 'sess-2')).toBe(true);
  });

  it('replace / clear overlay', async () => {
    const store = await openStore();
    store.register({
      kind: 'directory',
      location: '/tmp/p',
      scopeRef: { level: 'project', key: 'p' },
      displayName: 'P',
    });
    store.setSessionVisibility('sess-1', {
      targetType: 'project',
      targetId: 'p',
      op: 'include',
    });
    store.replaceSessionVisibility('sess-1', [
      { targetType: 'project', targetId: 'p', op: 'exclude' },
    ]);
    const items = store.listSessionVisibility('sess-1');
    expect(items).toHaveLength(1);
    expect(items[0]?.op).toBe('exclude');

    store.clearSessionVisibility('sess-1');
    expect(store.listSessionVisibility('sess-1')).toHaveLength(0);
  });

  it('listProjects 汇总源数与挂载', async () => {
    const store = await openStore();
    store.register({
      kind: 'directory',
      location: '/tmp/a',
      scopeRef: { level: 'project', key: 'alpha' },
      displayName: 'A',
    });
    store.register({
      kind: 'file',
      location: '/tmp/b',
      scopeRef: { level: 'project', key: 'alpha' },
      displayName: 'B',
    });
    store.assignProject('alpha', 'coder');
    const projects = store.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectKey).toBe('alpha');
    expect(projects[0]?.sourceCount).toBe(2);
    expect(projects[0]?.assignedAgentIds).toEqual(['coder']);
  });

  it('remove source 清理 source 级 overlay', async () => {
    const store = await openStore();
    const src = store.register({
      kind: 'file',
      location: '/tmp/x.md',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'X',
    });
    store.hideSource('coder', src.id);
    store.setSessionVisibility('sess-1', {
      targetType: 'source',
      targetId: src.id,
      op: 'include',
    });
    store.remove(src.id);
    expect(store.listSessionVisibility('sess-1')).toHaveLength(0);
    expect(store.listHidden('coder')).toHaveLength(0);
  });

  it('removeProject 拒绝非空；listProjects 不复活已删项目', async () => {
    const store = await openStore();
    const src = store.register({
      kind: 'directory',
      location: '/tmp/d',
      scopeRef: { level: 'project', key: 'p1' },
      displayName: 'D',
    });
    expect(store.listProjects().map((p) => p.projectKey)).toEqual(['p1']);
    expect(() => store.removeProject('p1')).toThrow(/source/);
    store.remove(src.id);
    expect(store.removeProject('p1')).toBe(true);
    expect(store.listProjects()).toHaveLength(0);
  });

  it('update 改到 project 时登记项目', async () => {
    const store = await openStore();
    const src = store.register({
      kind: 'file',
      location: '/tmp/g.md',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'G',
    });
    store.update(src.id, { scopeRef: { level: 'project', key: 'new-proj' } });
    expect(store.listProjects().map((p) => p.projectKey)).toContain('new-proj');
  });

  it('hideSource 仅允许 global 源', async () => {
    const store = await openStore();
    const proj = store.register({
      kind: 'directory',
      location: '/tmp/p',
      scopeRef: { level: 'project', key: 'p' },
      displayName: 'P',
    });
    expect(() => store.hideSource('coder', proj.id)).toThrow(/global/);
    const glob = store.register({
      kind: 'file',
      location: '/tmp/g',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'G',
    });
    expect(() => store.hideSource('coder', glob.id)).not.toThrow();
  });

  it('disabled/removed 不被 overlay include 复活', async () => {
    const store = await openStore();
    const src = store.register({
      kind: 'file',
      location: '/tmp/d.md',
      scopeRef: { level: 'project', key: 'd' },
      displayName: 'D',
      status: 'ready',
    });
    store.setSessionVisibility('sess-1', {
      targetType: 'source',
      targetId: src.id,
      op: 'include',
    });
    store.update(src.id, { status: 'disabled' });
    const reloaded = store.get(src.id);
    expect(reloaded?.status).toBe('disabled');
    expect(reloaded && store.isVisible(reloaded, 'coder', 'sess-1')).toBe(false);
  });
});
