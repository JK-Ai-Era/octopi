/**
 * Knowledge source location — 写入口归一化与词法校验
 *
 * 背景：粘贴 Windows「复制为路径」/ shell 复制会带包裹引号；旧实现把原文直接落库，
 * 索引时 stat 失败被静默吞成 0 文件 → 用户看到永久的「覆盖 0%」且「重建索引」无反应。
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSourceLocation,
  stripLocationWrapping,
} from '@octopi-agent/engine/harness/knowledge/location.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { LocalKnowledgeWriteService } from '@octopi-agent/engine/harness/knowledge/writer-service.js';

describe('stripLocationWrapping', () => {
  it('去两端空白与包裹引号（多层、中文引号、反引号）', () => {
    expect(stripLocationWrapping('  /Users/me/docs  ')).toBe('/Users/me/docs');
    expect(stripLocationWrapping('"/Users/me/docs"')).toBe('/Users/me/docs');
    expect(stripLocationWrapping("' /Users/me/docs '")).toBe('/Users/me/docs');
    expect(stripLocationWrapping('“/Users/me/文档”')).toBe('/Users/me/文档');
    expect(stripLocationWrapping('`/Users/me/docs`')).toBe('/Users/me/docs');
    expect(stripLocationWrapping(' " \'/Users/me/docs\' " ')).toBe('/Users/me/docs');
  });

  it('未成对的引号保持原样（不猜用户意图）', () => {
    expect(stripLocationWrapping('"/Users/me/docs')).toBe('"/Users/me/docs');
  });
});

describe('normalizeSourceLocation', () => {
  it('本地源：Windows 带引号路径去引号并保留原分隔符', () => {
    expect(normalizeSourceLocation('directory', '"C:\\Users\\James\\Documents\\云锡"')).toBe(
      'C:\\Users\\James\\Documents\\云锡',
    );
  });

  it('本地源：相对路径必须被拒绝', () => {
    expect(() => normalizeSourceLocation('directory', 'docs/arch')).toThrow(/absolute path/);
    expect(() => normalizeSourceLocation('directory', '~/docs')).toThrow(/absolute path/);
    expect(() => normalizeSourceLocation('file', '')).toThrow(/required/);
  });

  it('url 源：只接受 http(s)', () => {
    expect(normalizeSourceLocation('url', 'https://example.com/docs')).toBe(
      'https://example.com/docs',
    );
    expect(() => normalizeSourceLocation('url', 'ftp://example.com/docs')).toThrow(/http\(s\)/);
    expect(() => normalizeSourceLocation('url', '/Users/me/docs')).toThrow(/http\(s\)/);
  });

  it('connector：JSON 配置可解析，坏 JSON / 非 URL 被拒绝', () => {
    const cfg = '{"type":"rest","listUrl":"https://api.example.com/list"}';
    expect(normalizeSourceLocation('connector', cfg)).toBe(cfg);
    expect(normalizeSourceLocation('connector', 'https://api.example.com/list')).toBe(
      'https://api.example.com/list',
    );
    expect(() => normalizeSourceLocation('connector', '{not json}')).toThrow(/JSON is invalid/);
    expect(() => normalizeSourceLocation('connector', '["a"]')).toThrow(
      /JSON config or http\(s\) URL/,
    );
    expect(() => normalizeSourceLocation('connector', 'api.example.com')).toThrow(
      /JSON config or http\(s\) URL/,
    );
  });

  it('幂等：归一化结果再归一化不变', () => {
    const once = normalizeSourceLocation('directory', '"/Users/me/docs"');
    expect(normalizeSourceLocation('directory', once)).toBe(once);
  });
});

describe('写入口接线（register / update）', () => {
  const identity = { tenantId: 'acme', gatewayId: 'gw-a' };

  async function openWrite() {
    const store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const write = new LocalKnowledgeWriteService({ db: store.database, allowPublic: true });
    return { store, write };
  }

  it('registerSource 落库前剥离包裹引号（用户报的那一例）', async () => {
    const { store, write } = await openWrite();
    const created = await write.registerSource(identity, {
      kind: 'directory',
      location: '"C:\\Users\\James\\Documents\\云锡"',
      scopeRef: { level: 'global', key: 'global' },
      displayName: '云锡',
      sync: { enabled: false, strategy: 'manual' },
    });
    expect(store.get(created.id)!.location).toBe('C:\\Users\\James\\Documents\\云锡');
    await write.dispose();
    store.database.close();
  });

  it('registerSource 拒绝相对路径（不造死源）', async () => {
    const { store, write } = await openWrite();
    await expect(
      write.registerSource(identity, {
        kind: 'directory',
        location: 'docs/arch',
        scopeRef: { level: 'global', key: 'global' },
      }),
    ).rejects.toThrow(/absolute path/);
    expect(store.list()).toHaveLength(0);
    await write.dispose();
    store.database.close();
  });

  it('updateSource 的 location 也过同一归一化；url 源拒绝本地路径', async () => {
    const { store, write } = await openWrite();
    const dir = await write.registerSource(identity, {
      kind: 'directory',
      location: '/tmp/kn-a',
      scopeRef: { level: 'global', key: 'global' },
      sync: { enabled: false, strategy: 'manual' },
    });
    await write.updateSource(identity, dir.id, { location: '  "/tmp/kn-b"  ' });
    expect(store.get(dir.id)!.location).toBe('/tmp/kn-b');

    const url = await write.registerSource(identity, {
      kind: 'url',
      location: 'https://example.com/docs',
      scopeRef: { level: 'global', key: 'global' },
      sync: { enabled: false, strategy: 'manual' },
    });
    await expect(write.updateSource(identity, url.id, { location: '/tmp/kn-c' })).rejects.toThrow(
      /http\(s\)/,
    );
    // 失败的 patch 不得留下半截修改
    expect(store.get(url.id)!.location).toBe('https://example.com/docs');

    await write.dispose();
    store.database.close();
  });

  it('updateSource 对不存在的源返回 null（404 语义，不被归一化抢成 400）', async () => {
    const { store, write } = await openWrite();
    await expect(
      write.updateSource(identity, 'ks_missing', { location: 'relative/path' }),
    ).resolves.toBeNull();
    await write.dispose();
    store.database.close();
  });
});
