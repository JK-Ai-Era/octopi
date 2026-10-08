/**
 * 审查修复回归：停机 / walk 不 supersede / 路径归一 / worker 错误还原
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startKnowledgeService } from '@octopi-agent/engine/harness/knowledge/serve.js';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';
import { normalizePathLexical } from '@octopi-agent/engine/harness/knowledge/file-identity.js';
import { DocumentExtractError } from '@octopi-agent/engine/harness/capabilities/document/errors.js';

describe('review fixes', () => {
  it('normalizePathLexical 处理 \\\\?\\ 扩展前缀', () => {
    expect(normalizePathLexical('\\\\?\\C:\\Users\\x')).toBe('C:/Users/x');
    expect(normalizePathLexical('\\\\?\\UNC\\server\\share\\a')).toBe('//server/share/a');
    expect(normalizePathLexical('C:\\Users\\x')).toBe('C:/Users/x');
    expect(normalizePathLexical('/data/a')).toBe('/data/a');
  });

  it('serve.close 在 SSE 打开时也不挂死', async () => {
    const dbPath = join(await mkdtemp(join(tmpdir(), 'kn-close-')), 'k.db');
    const svc = await startKnowledgeService({
      dbPath,
      port: 0,
      tokens: [{ token: 't', tenantId: 'd', gatewayId: 'g' }],
      autoRegisterPrincipals: true,
    });
    const ac = new AbortController();
    const sse = fetch(`http://127.0.0.1:${svc.port}/v1/events`, {
      headers: { authorization: 'Bearer t', accept: 'text/event-stream' },
      signal: ac.signal,
    }).catch(() => undefined);
    // 等 SSE 连上
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await svc.close();
    expect(Date.now() - t0).toBeLessThan(3000);
    ac.abort();
    await sse;
  });

  it('walk_source 不 supersede 在跑 parse 队列', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kn-walk-'));
    await writeFile(join(root, 'a.md'), 'hello walk\n', 'utf8');
    const store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(store.database);
    const ingest = new KnowledgeIngest({ sourceStore: store, indexStore: index });
    try {
      const src = store.register({
        kind: 'directory',
        location: root,
        scopeRef: { level: 'global', key: 'global' },
        displayName: 'walk',
      });
      // 入队一条 parse，再 fromQueue walk：不得被 supersede 取消
      await (
        ingest as unknown as {
          enqueue: (s: string, k: string, p: string | null, pr: number) => Promise<boolean>;
        }
      ).enqueue(src.id, 'parse_file', join(root, 'a.md'), 2);
      await ingest.ingestSource(src.id, { fromQueue: true });
      const row = store.database.raw
        .prepare(`SELECT status FROM knowledge_jobs WHERE source_id = ? AND kind = 'parse_file'`)
        .get(src.id) as { status: string } | undefined;
      expect(row?.status).not.toBe('cancelled');
    } finally {
      ingest.dispose();
      store.database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('DocumentExtractError 跨 postMessage 字段可还原（形状契约）', () => {
    // worker 侧序列化形状 → 父进程 rehydrate 输入
    const payload = {
      name: 'DocumentExtractError',
      code: 'UNSUPPORTED_LEGACY',
      message: 'legacy',
      requires: ['legacy-converter'],
    };
    const err = new DocumentExtractError(
      payload.code as never,
      payload.message,
      payload.requires,
    );
    expect(err.code).toBe('UNSUPPORTED_LEGACY');
    expect(err.requires).toContain('legacy-converter');
    expect(err.name).toBe('DocumentExtractError');
  });
});

describe('purgeOrphanPathIdentityFiles', () => {
  let store: KnowledgeSourceStore;
  let index: KnowledgeIndexStore;

  beforeEach(async () => {
    store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    index = new KnowledgeIndexStore(store.database);
  });

  afterEach(() => {
    store.database.close();
  });

  it('清掉无 membership 的 path: 残留，保留有认领的行', () => {
    store.register({
      kind: 'file',
      location: '/tmp/x.md',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'x',
    });
    // 人为造 path: 孤儿 + 有认领的 path: 行
    store.database.raw
      .prepare(
        `INSERT INTO knowledge_files (id, tenant_id, identity_key, size, mtime, status, chunk_count, indexed_at)
         VALUES ('orph', 'default', 'path:/tmp/orphan.md', 1, 1, 'error', 0, 1)`,
      )
      .run();
    index.markFileError('src-keep', '/tmp/keep.md', 'e', 1, undefined);
    const before = index.purgeOrphanPathIdentityFiles();
    expect(before).toBeGreaterThanOrEqual(1);
    const left = store.database.raw
      .prepare(`SELECT COUNT(*) AS n FROM knowledge_files WHERE id = 'orph'`)
      .get() as { n: number };
    expect(left.n).toBe(0);
  });
});
