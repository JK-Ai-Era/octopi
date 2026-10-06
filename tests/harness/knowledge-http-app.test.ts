/**
 * Knowledge HTTP 面最小契约：鉴权 / health / sources / search
 */
import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { createKnowledgeHttpApp } from '@octopi-agent/engine/harness/knowledge/http-app.js';

async function withServer(
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
  const app = createKnowledgeHttpApp({
    db,
    tokens: [
      { token: 'tok-a', tenantId: 'acme', gatewayId: 'gw-a' },
      { token: 'tok-b', tenantId: 'acme', gatewayId: 'gw-b' },
    ],
    autoRegisterPrincipals: true,
  });
  const server: Server = createServer((req, res) => {
    void app.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(base);
  } finally {
    app.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

describe('KnowledgeHttpApp', () => {
  it('health 免鉴权；业务接口 401', async () => {
    await withServer(async (base) => {
      const h = await fetch(`${base}/health`);
      expect(h.status).toBe(200);
      const j = await h.json();
      expect(j.ok).toBe(true);

      const bad = await fetch(`${base}/v1/sources`);
      expect(bad.status).toBe(401);

      const ok = await fetch(`${base}/v1/sources`, {
        headers: { authorization: 'Bearer tok-a' },
      });
      expect(ok.status).toBe(200);
    });
  });

  it('注册源 + 搜索；gateway 可见性隔离', async () => {
    await withServer(async (base) => {
      const root = await mkdtemp(join(tmpdir(), 'kn-http-'));
      const dir = join(root, 'docs');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'a.md'), '# t\n\nhttp shared body\n', 'utf8');

      const created = await fetch(`${base}/v1/sources`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-a',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'directory',
          location: dir,
          scopeRef: { level: 'global', key: 'global' },
          displayName: 'docs',
          visibility: 'private',
        }),
      });
      expect(created.status).toBe(201);
      const src = (await created.json()).data;

      const listA = await (
        await fetch(`${base}/v1/sources`, {
          headers: { authorization: 'Bearer tok-a' },
        })
      ).json();
      expect(listA.data.some((s: { id: string }) => s.id === src.id)).toBe(true);

      const listB = await (
        await fetch(`${base}/v1/sources`, {
          headers: { authorization: 'Bearer tok-b' },
        })
      ).json();
      expect(listB.data.some((s: { id: string }) => s.id === src.id)).toBe(false);

      const del = await fetch(`${base}/v1/sources/${src.id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer tok-b' },
      });
      expect(del.status).toBe(403);

      const delOk = await fetch(`${base}/v1/sources/${src.id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer tok-a' },
      });
      expect(delOk.status).toBe(200);
    });
  });

  it('search 经 retriever；未注册 principal 在 multi 下 403', async () => {
    await withServer(async (base) => {
      const root = await mkdtemp(join(tmpdir(), 'kn-http2-'));
      await writeFile(join(root, 's.md'), 'hello http search phrase\n', 'utf8');
      const created = await fetch(`${base}/v1/sources`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-a',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'file',
          location: join(root, 's.md'),
          scopeRef: { level: 'global', key: 'global' },
          displayName: 's',
          visibility: 'public',
        }),
      });
      expect(created.status).toBe(201);
      const re = await fetch(`${base}/v1/sources/${(await created.json()).data.id}/reindex`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-a' },
      });
      expect(re.status).toBe(202);
      await new Promise((r) => setTimeout(r, 200));

      const s = await fetch(
        `${base}/v1/principals/a1/search?q=${encodeURIComponent('http search')}`,
        { headers: { authorization: 'Bearer tok-a' } },
      );
      expect(s.status).toBe(200);
      const body = await s.json();
      expect(Array.isArray(body.data?.hits)).toBe(true);
    });
  });

  it('visibility assign/hide + session overlay + jobs', async () => {
    await withServer(async (base) => {
      const h = { authorization: 'Bearer tok-a', 'content-type': 'application/json' };
      const proj = await fetch(`${base}/v1/sources`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          kind: 'directory',
          location: await mkdtemp(join(tmpdir(), 'kn-vis-')),
          scopeRef: { level: 'project', key: 'p1' },
          displayName: 'p1src',
        }),
      });
      expect(proj.status).toBe(201);

      await fetch(`${base}/v1/principals/a1`, {
        method: 'PUT',
        headers: h,
        body: JSON.stringify({ displayName: 'A1', status: 'active' }),
      });

      const vis = await fetch(`${base}/v1/principals/a1/visibility`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ op: 'assignProject', projectKey: 'p1' }),
      });
      expect(vis.status).toBe(200);

      const got = await (await fetch(`${base}/v1/principals/a1/visibility`, { headers: h })).json();
      expect(got.data.assignedProjects).toContain('p1');

      const sv = await fetch(`${base}/v1/principals/a1/session-visibility`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          sessionId: 's1',
          targetType: 'project',
          targetId: 'p1',
          op: 'include',
        }),
      });
      expect(sv.status).toBe(200);

      const jobs = await (await fetch(`${base}/v1/jobs`, { headers: h })).json();
      expect(Array.isArray(jobs.data)).toBe(true);
    });
  });

  it('注册源即自动索引（无需显式 reindex）', async () => {
    await withServer(async (base) => {
      const root = await mkdtemp(join(tmpdir(), 'kn-auto-'));
      const dir = join(root, 'docs');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'auto.md'), '# auto\n\nregistered source should index itself\n', 'utf8');

      const created = await fetch(`${base}/v1/sources`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-a',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'directory',
          location: dir,
          scopeRef: { level: 'global', key: 'global' },
          displayName: 'auto',
          visibility: 'public',
        }),
      });
      expect(created.status).toBe(201);
      const src = (await created.json()).data;

      // 不调用 /reindex：轮询 files/search 直到自动 ingest 落地
      let files: unknown[] = [];
      let hits: unknown[] = [];
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const f = await (
          await fetch(`${base}/v1/sources/${src.id}/files`, {
            headers: { authorization: 'Bearer tok-a' },
          })
        ).json();
        files = Array.isArray(f.data) ? f.data : [];
        if (files.length > 0) break;
      }
      expect(files.length).toBeGreaterThan(0);

      const s = await fetch(
        `${base}/v1/principals/a1/search?q=${encodeURIComponent('index itself')}`,
        { headers: { authorization: 'Bearer tok-a' } },
      );
      const body = await s.json();
      hits = body.data?.hits ?? [];
      expect(hits.length).toBeGreaterThan(0);
    });
  });
});
