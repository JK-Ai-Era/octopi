/**
 * 会话软删（回收站）gateway 级闭环 —— P0 验证环：
 * 软删 → 回收站列表 → 恢复 → 再删 → 彻底删除；手动归档 → 删除改标（归档→trashed）；
 * spawnBy 级联组共进退。真实 JsonlSessionStore + 临时 OCTOPI_HOME（封存目录随 home 隔离）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

/** 建会话（可选父会话） */
async function makeSession(id: string, spawnParent?: string): Promise<void> {
  await store.save(id, {
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
  } as unknown as SessionData);
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
