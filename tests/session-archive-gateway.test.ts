/**
 * 会话软删（回收站）gateway 级闭环 —— P0 验证环：
 * 软删 → 回收站列表 → 恢复 → 再删 → 彻底删除；手动归档 → 删除改标（归档→trashed）；
 * spawnBy 级联组共进退。真实 JsonlSessionStore + 临时 OCTOPI_HOME（封存目录随 home 隔离）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { GatewayConfig } from '@octopi-agent/gateway/types/gateway-config.js';

let home: string;
let store: JsonlSessionStore;
let gateway: Gateway;
const savedHome = process.env.OCTOPI_HOME;

function makeGateway(): Gateway {
  return new Gateway(
    {
      agents: [{ id: 'a1', model: { provider: 'mock', model: 'm' } }],
    } as unknown as GatewayConfig,
    store,
  );
}

/** 会话数据（迁移夹具复用：构造但不落库） */
function sessionData(id: string, spawnParent?: string, opts?: { endedAt?: number }): SessionData {
  return {
    id,
    agentId: 'a1',
    messages: [{ role: 'user', content: `hi ${id}` }],
    meta: {
      id,
      tenantId: 'default',
      agentId: 'a1',
      title: `会话 ${id}`,
      createdAt: 1000,
      updatedAt: 2000,
    },
    // spawnBy 权威在顶层（存 state.json；meta 投影由此重建）
    spawnBy: spawnParent ? { parentSessionId: spawnParent } : null,
    metadata: { title: `会话 ${id}` },
    tasks: [],
    ...(opts?.endedAt != null ? { lifecycle: { lifecycle: 'recent', endedAt: opts.endedAt } } : {}),
  } as unknown as SessionData;
}

/** 建会话（可选父会话；endedAt 给 lifecycle=recent 供自动冷归档提名） */
async function makeSession(
  id: string,
  spawnParent?: string,
  opts?: { endedAt?: number },
): Promise<void> {
  await store.save(id, sessionData(id, spawnParent, opts));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'octopi-gw-archive-'));
  process.env.OCTOPI_HOME = home;
  store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
  gateway = makeGateway();
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.OCTOPI_HOME;
  else process.env.OCTOPI_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

describe('软删（回收站）gateway 闭环', () => {
  it('软删 → 列表 → 恢复 → 再删 → 彻底删除', async () => {
    await makeSession('s1');

    await gateway.deleteSession('s1');
    // 热库无、回收站有（trashed + TTL 到期时间）
    expect(await store.load('s1')).toBeNull();
    const trashed = await gateway.listArchives('trashed');
    expect(trashed.map((e) => e.sessionId)).toEqual(['s1']);
    expect(trashed[0]?.purgeAt).toBeGreaterThan(Date.now());

    // 恢复：回热库，回收站清空
    const { restored, warnings } = await gateway.restoreArchive('s1');
    expect(restored).toEqual(['s1']);
    expect(warnings).toEqual([]); // 无附件可检索源 → 无警告
    expect(await store.load('s1')).not.toBeNull();
    expect(await gateway.listArchives()).toEqual([]);

    // 再删 → 彻底删除
    await gateway.deleteSession('s1');
    expect((await gateway.listArchives('trashed'))).toHaveLength(1);
    const { purged } = await gateway.purgeArchive('s1');
    expect(purged).toEqual(['s1']);
    expect(await gateway.listArchives()).toEqual([]);
    expect(await store.load('s1')).toBeNull();
  });

  it('删除不存在的会话幂等成功', async () => {
    await expect(gateway.deleteSession('ghost')).resolves.toEqual({ sealed: 0, purgeAt: null });
  });

  it('手动归档（purgeAt=null）→ 删除改标回收站（归档→trashed）', async () => {
    await makeSession('s2');
    await gateway.archiveSession('s2');
    const archived = await gateway.listArchives('archived');
    expect(archived.map((e) => e.sessionId)).toEqual(['s2']);
    expect(archived[0]?.purgeAt).toBeNull(); // 手动归档永久
    expect(await store.load('s2')).toBeNull();

    // 已封存再删 = 归档 → 回收站（改标 TTL，不重建包）
    await gateway.deleteSession('s2');
    const trashed = await gateway.listArchives('trashed');
    expect(trashed.map((e) => e.sessionId)).toEqual(['s2']);
    expect(trashed[0]?.purgeAt).toBeGreaterThan(Date.now());
    expect((await gateway.listArchives('archived'))).toEqual([]);
  });

  it('重复删除已 trashed 会话不重置 TTL', async () => {
    await makeSession('s3');
    await gateway.deleteSession('s3');
    const first = (await gateway.listArchives('trashed'))[0]!.purgeAt;
    await gateway.deleteSession('s3');
    const second = (await gateway.listArchives('trashed'))[0]!.purgeAt;
    expect(second).toBe(first); // 再删不拉长回收站寿命
  });

  it('spawnBy 级联：父删 → 子随组入回收站，恢复整组', async () => {
    await makeSession('p');
    await makeSession('c1', 'p');
    await gateway.deleteSession('p');
    expect((await gateway.listArchives('trashed')).map((e) => e.sessionId).sort()).toEqual(['c1', 'p']);
    expect(new Set((await gateway.listArchives('trashed')).map((e) => e.groupSealId)).size).toBe(1);

    // 从子会话 id 恢复 → 整组回热库
    await gateway.restoreArchive('c1');
    expect(await store.load('p')).not.toBeNull();
    expect(await store.load('c1')).not.toBeNull();
    expect(await gateway.listArchives()).toEqual([]);
  });
});

describe('清空回收站（purgeTrash）', () => {
  it('批量销毁全部 trashed + bytes 累计；archived 不受影响', async () => {
    await makeSession('t1');
    await makeSession('t2');
    await makeSession('keep');
    await gateway.deleteSession('t1');
    await gateway.deleteSession('t2');
    await gateway.archiveSession('keep');
    const { purged, bytes, warnings } = await gateway.purgeTrash();
    expect(purged.sort()).toEqual(['t1', 't2']);
    expect(bytes).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
    expect(await gateway.listArchives('trashed')).toEqual([]);
    expect((await gateway.listArchives('archived')).map((e) => e.sessionId)).toEqual(['keep']);
  });

  it('组级：一次销毁整组（含 spawnBy 子会话）', async () => {
    await makeSession('p');
    await makeSession('c1', 'p');
    await gateway.deleteSession('p');
    const { purged } = await gateway.purgeTrash();
    expect(purged.sort()).toEqual(['c1', 'p']);
    expect(await gateway.listArchives()).toEqual([]);
  });

  it('租户限定：onlyTenantId 过滤后本租户外条目不动', async () => {
    await makeSession('t1');
    await gateway.deleteSession('t1');
    const { purged } = await gateway.purgeTrash('other-tenant');
    expect(purged).toEqual([]);
    expect(await gateway.listArchives('trashed')).toHaveLength(1);
  });
});

const gzipAsync = promisify(gzip);

describe('旧月度冷备迁移（migrateLegacyMonthlyArchives）', () => {
  /** 构造旧月度 gz 文件（行内容原样写入） */
  async function writeLegacyFile(name: string, lines: string[]): Promise<string> {
    const archivesDir = join(home, 'archives');
    await mkdir(archivesDir, { recursive: true });
    const file = join(archivesDir, name);
    await writeFile(file, await gzipAsync(Buffer.from(lines.join('\n') + '\n')));
    return file;
  }

  it('gz → bundle 一次性转换：入册 archived/auto、热库清空、旧文件删除；重跑幂等', async () => {
    const file = await writeLegacyFile('2026-09.sessions.jsonl.gz', [
      JSON.stringify({ sessionId: 'old-1', data: sessionData('old-1'), archivedAt: 123 }),
    ]);
    const r = await gateway.migrateLegacyMonthlyArchives();
    expect(r.converted).toEqual(['old-1']);
    expect(r.filesRemoved).toEqual([file]);
    // 热库清空、注册表入册（sealedBy=auto、存期派生）、bundle 落位
    expect(await store.load('old-1')).toBeNull();
    const entries = await gateway.listArchives('archived');
    expect(entries.map((e) => e.sessionId)).toEqual(['old-1']);
    expect(entries[0]!.sealedBy).toBe('auto');
    expect(entries[0]!.purgeAt).toBeGreaterThan(Date.now());
    expect(existsSync(join(home, 'archives', 'sessions', 'old-1.tar.gz'))).toBe(true);
    // 正文可读回（bundle 权威）
    expect(await store.load('old-1')).toBeNull();

    // 幂等重跑：无事发生
    const r2 = await gateway.migrateLegacyMonthlyArchives();
    expect(r2.converted).toEqual([]);
    expect(r2.filesRemoved).toEqual([]);
  });

  it('spawnBy 组跨条目：一次迁移整组共进退（同 groupSealId）', async () => {
    await writeLegacyFile('2026-10.sessions.jsonl.gz', [
      JSON.stringify({ sessionId: 'p', data: sessionData('p'), archivedAt: 1 }),
      JSON.stringify({ sessionId: 'c1', data: sessionData('c1', 'p'), archivedAt: 2 }),
    ]);
    const r = await gateway.migrateLegacyMonthlyArchives();
    expect(r.converted.sort()).toEqual(['c1', 'p']);
    const entries = await gateway.listArchives('archived');
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.groupSealId)).size).toBe(1);
  });

  it('热库撞 id 不覆盖 + 坏行不丢：两者都保留旧文件', async () => {
    await makeSession('hot-1'); // 热库同 id 在世
    const file = await writeLegacyFile('2026-11.sessions.jsonl.gz', [
      JSON.stringify({ sessionId: 'hot-1', data: sessionData('hot-1'), archivedAt: 1 }),
      JSON.stringify({ sessionId: 'old-2', data: sessionData('old-2'), archivedAt: 2 }),
      '{bad json',
    ]);
    const r = await gateway.migrateLegacyMonthlyArchives();
    expect(r.converted).toEqual(['old-2']);
    expect(r.warnings.some((w) => w.includes('hot-1'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('unreadable'))).toBe(true);
    // 撞 id 的热库正文未被覆盖；旧文件保留（坏行/未转条目只存在于源文件）
    const hot = await store.load('hot-1');
    expect(hot?.messages[0]?.content).toBe('hi hot-1');
    expect(existsSync(file)).toBe(true);
  });
});

describe('自动冷归档全链路（retention 提名 → 组级封存）', () => {
  it('recent 超期父子会话整组封存：sealedBy=auto、存期派生、热库清空', async () => {
    const endedAt = Date.now() - 200 * 24 * 60 * 60 * 1000;
    await makeSession('p', undefined, { endedAt });
    await makeSession('c1', 'p', { endedAt });
    await gateway.runArchiveRetention();

    const archived = await gateway.listArchives('archived');
    expect(archived.map((e) => e.sessionId).sort()).toEqual(['c1', 'p']);
    // 级联组：同一 groupSealId（组级封存走 sealSessionGroup：关账 + 级联 + 广播）
    expect(new Set(archived.map((e) => e.groupSealId)).size).toBe(1);
    for (const e of archived) {
      expect(e.sealedBy).toBe('auto');
      // 自动包存期：缺省 180 天（purgeAt = now + retentionDays）
      expect(e.purgeAt).toBeGreaterThan(Date.now() + 170 * 24 * 60 * 60 * 1000);
    }
    expect(await store.load('p')).toBeNull();
    expect(await store.load('c1')).toBeNull();
  });

  it('recent 未超期不提名（保留期内留在热库）', async () => {
    await makeSession('fresh', undefined, { endedAt: Date.now() - 86400000 });
    await gateway.runArchiveRetention();
    expect(await store.load('fresh')).not.toBeNull();
    expect(await gateway.listArchives('archived')).toEqual([]);
  });
});
