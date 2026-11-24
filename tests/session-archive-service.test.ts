/**
 * 会话封存服务（seal/restore/purge/reconcile/retention）—— 真实 JsonlSessionStore 走盘
 *
 * - seal(trash)：热库搬迁清空、wire dump 清除（缺省）、注册表就绪、包内容核对（含 derived/transform）
 * - restore：文件/meta（createdAt 保真）/schedules 回插；knowledge 重登记缺位显式警告
 * - seal→purge：包与残余零残留
 * - includeLlmDumps：dump 随包往返
 * - 级联组（spawnBy 子会话）：同组共进退（seal/restore/purge）
 * - 崩溃矩阵 reconcile：旁车在→续封；意图空账→撤行；restoring→续恢复；staging 无旁车→不动+警告
 * - runRetention：到期 trashed 整组销毁；auto 归档 recent 超期
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import {
  SessionArchiveService,
  type SessionArchiveStorePort,
  type SessionArchiveSchedulesPort,
  type SessionArchiveKnowledgePort,
} from '@octopi-agent/engine/integration/storage/archives/service.js';
import { ArchiveRegistry } from '@octopi-agent/engine/integration/storage/archives/registry.js';
import { readBundleManifest } from '@octopi-agent/engine/integration/storage/archives/bundle.js';
import { sanitizeSessionDirName } from '@octopi-agent/engine/integration/providers/wire-dump.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';

const DAY_MS = 86_400_000;
const FIXED_NOW = 1_800_000_000_000;

let root: string;
let sessionsDir: string;
let archivesDir: string;
let wireDumpDir: string;
let store: JsonlSessionStore;
let schedules: SessionArchiveSchedulesPort;
let knowledge: SessionArchiveKnowledgePort;
let service: SessionArchiveService;

function makeService(storePort: SessionArchiveStorePort = store): SessionArchiveService {
  return new SessionArchiveService({
    sessionsDir,
    archivesDir,
    store: storePort,
    schedules,
    knowledge,
    wireDumpDir,
    trashRetentionDays: 30,
    autoArchive: { enabled: true, recentRetentionDays: 30, forceDays: 90, retentionDays: 180 },
    now: () => FIXED_NOW,
  });
}

/** 建一个会话：messages + meta + 附件/派生/转换 + wire dump */
async function makeSession(
  id: string,
  opts: {
    spawnParent?: string;
    lifecycle?: 'active' | 'recent';
    endedAt?: number;
    withDump?: boolean;
  } = {},
): Promise<void> {
  await store.save(id, {
    id,
    agentId: 'a1',
    messages: [{ role: 'user', content: `hello ${id}` }],
    meta: {
      id,
      tenantId: 'default',
      agentId: 'a1',
      title: `会话 ${id}`,
      createdAt: 4242,
      lastInteractionAt: FIXED_NOW - DAY_MS,
      updatedAt: FIXED_NOW - DAY_MS,
      endedAt: opts.endedAt,
      lifecycle: opts.lifecycle ?? 'active',
      spawnBy: opts.spawnParent ? { parentSessionId: opts.spawnParent } : null,
    },
    metadata: { title: `会话 ${id}` },
    tasks: [],
  } as unknown as SessionData);
  const base = id;
  await mkdir(join(sessionsDir, base, 'attachments'), { recursive: true });
  await mkdir(join(sessionsDir, base, 'derived'), { recursive: true });
  await mkdir(join(sessionsDir, base, 'transform'), { recursive: true });
  await writeFile(join(sessionsDir, base, 'attachments', 'a.bin'), Buffer.from([1, 2, 3]));
  await writeFile(
    join(sessionsDir, base, 'attachments', 'manifest.json'),
    JSON.stringify({
      sessionId: id,
      version: 1,
      items: [{ id: 'att1', path: 'attachments/a.bin', searchableSourceId: 'src-1' }],
    }),
  );
  await writeFile(join(sessionsDir, base, 'derived', 'd.png'), 'derived-bytes');
  await writeFile(join(sessionsDir, base, 'transform', 't.json'), '{"summary":1}');
  if (opts.withDump !== false) {
    // 夹具即写入方：目录名按 wire-dump.ts 的 sanitizeSessionDirName（勿用原始 id）
    await mkdir(join(wireDumpDir, sanitizeSessionDirName(id)), { recursive: true });
    await writeFile(join(wireDumpDir, sanitizeSessionDirName(id), 'req.json'), '{"wire":1}');
    await writeFile(join(wireDumpDir, sanitizeSessionDirName(id), 'index.jsonl'), '{"id":"r1"}\n');
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'octopi-archive-svc-'));
  sessionsDir = join(root, 'home', 'sessions');
  archivesDir = join(root, 'home', 'archives');
  wireDumpDir = join(root, 'home', 'logs', 'llm-requests');
  await mkdir(sessionsDir, { recursive: true });
  store = new JsonlSessionStore({ sessionsDir });
  schedules = {
    snapshotForArchive: vi.fn(() => [{ id: 'sch1' }]),
    purgeSession: vi.fn(() => 1),
    restoreForArchive: vi.fn(),
  } as unknown as SessionArchiveSchedulesPort;
  knowledge = {
    purgeSessionSources: vi.fn(async () => undefined),
  } as unknown as SessionArchiveKnowledgePort;
  service = makeService();
});

afterEach(async () => {
  service.close();
  await rm(root, { recursive: true, force: true });
});

describe('seal（trash）', () => {
  it('热库清空、dump 清除、注册表就绪、包内容完整（含 derived/transform/附件）', async () => {
    await makeSession('s1');
    const { sealed } = await service.seal({ sessionId: 's1', state: 'trashed', sealedBy: 'trash' });
    expect(sealed).toHaveLength(1);

    // 热库零残留（含 derived —— P1 漏项回归钉）
    expect(existsSync(join(sessionsDir, 's1.jsonl'))).toBe(false);
    expect(existsSync(join(sessionsDir, 's1.state.json'))).toBe(false);
    expect(existsSync(join(sessionsDir, 's1'))).toBe(false);
    // wire dump 缺省直删（不入回收站）
    expect(existsSync(join(wireDumpDir, 's1'))).toBe(false);

    // 注册表
    const entries = service.list('trashed');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sessionId: 's1',
      state: 'trashed',
      phase: 'ready',
      sealedBy: 'trash',
      title: '会话 s1',
      messageCount: 1,
      purgeAt: FIXED_NOW + 30 * DAY_MS,
    });

    // 包内容
    const manifest = await readBundleManifest(join(archivesDir, 'sessions', 's1.tar.gz'));
    expect(manifest.files.map((f) => f.path).sort()).toEqual([
      'attachments/a.bin',
      'attachments/manifest.json',
      'derived/d.png',
      's1.jsonl',
      's1.state.json',
      'transform/t.json',
    ]);
    expect(manifest.metaRaw).toMatchObject({ createdAt: 4242, title: '会话 s1' });
    expect(manifest.knowledgeSources).toEqual([
      { sourceId: 'src-1', attachmentFile: 'attachments/a.bin' },
    ]);

    // 副效应端口
    expect(schedules.snapshotForArchive).toHaveBeenCalledWith('s1');
    expect(schedules.purgeSession).toHaveBeenCalledWith('s1');
    expect(knowledge.purgeSessionSources).toHaveBeenCalledWith('s1', ['src-1'], 'a1');
  });

  it('已在册 id 拒绝重封（entry_exists）：不踩就绪行、不改写组 id', async () => {
    await makeSession('s1');
    const first = await service.seal({ sessionId: 's1', state: 'archived', sealedBy: 'manual' });
    await expect(
      service.seal({ sessionId: 's1', state: 'archived', sealedBy: 'auto' }),
    ).rejects.toThrow(/entry_exists/);
    const rows = service.list('archived');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phase).toBe('ready');
    expect(rows[0]!.groupSealId).toBe(first.sealed[0]!.groupSealId);
  });

  it('purgeAt 派生：trash=+30d / manual=null / auto=+180d', async () => {
    await makeSession('a', { withDump: false });
    await makeSession('b', { withDump: false });
    await makeSession('c', { withDump: false });
    await service.seal({ sessionId: 'a', state: 'trashed', sealedBy: 'trash' });
    await service.seal({ sessionId: 'b', state: 'archived', sealedBy: 'manual' });
    await service.seal({ sessionId: 'c', state: 'archived', sealedBy: 'auto' });
    const byId = new Map(service.list().map((e) => [e.sessionId, e]));
    expect(byId.get('a')?.purgeAt).toBe(FIXED_NOW + 30 * DAY_MS);
    expect(byId.get('b')?.purgeAt).toBeNull();
    expect(byId.get('c')?.purgeAt).toBe(FIXED_NOW + 180 * DAY_MS);
  });
});

describe('restore', () => {
  it('文件/meta/schedules 回归；knowledge 重登记缺位显式警告', async () => {
    await makeSession('s1');
    await service.seal({ sessionId: 's1', state: 'trashed', sealedBy: 'trash' });
    const { restored, warnings } = await service.restore('s1');

    expect(restored).toHaveLength(1);
    expect(warnings.some((w) => w.includes('可恢复检索'))).toBe(true);

    // 热库完整回归
    expect(await readFile(join(sessionsDir, 's1.jsonl'), 'utf-8')).toContain('hello s1');
    expect(await readFile(join(sessionsDir, 's1', 'derived', 'd.png'), 'utf-8')).toBe('derived-bytes');
    expect(await readFile(join(sessionsDir, 's1', 'attachments', 'a.bin'))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    // meta 非 state 权威字段保真（createdAt 不回退默认）
    const meta = await store.getMeta('s1');
    expect(meta?.createdAt).toBe(4242);
    expect(meta?.title).toBe('会话 s1');
    // schedules 回插
    expect(schedules.restoreForArchive).toHaveBeenCalledWith([{ id: 'sch1' }]);
    // 注册表与包清零
    expect(service.list()).toHaveLength(0);
    expect(existsSync(join(archivesDir, 'sessions', 's1.tar.gz'))).toBe(false);
    // dump 已在封存时直删，不随 restore 复活
    expect(existsSync(join(wireDumpDir, 's1'))).toBe(false);
  });

  it('restoreSessionSources 端口在位：按 manifest 映射重登记并透传警告', async () => {
    const restoreSessionSources = vi.fn(async () => ['重登记警告-1']);
    (knowledge as { restoreSessionSources?: typeof restoreSessionSources }).restoreSessionSources =
      restoreSessionSources;
    await makeSession('s1');
    await service.seal({ sessionId: 's1', state: 'trashed', sealedBy: 'trash' });
    const { warnings } = await service.restore('s1');
    expect(restoreSessionSources).toHaveBeenCalledWith('s1', [
      { sourceId: 'src-1', attachmentFile: 'attachments/a.bin' },
    ]);
    expect(warnings).toContain('重登记警告-1');
    // 端口在位时不再出「需重开可恢复检索」的降级警告
    expect(warnings.some((w) => w.includes('可恢复检索'))).toBe(false);
  });

  it('includeLlmDumps=true：dump 随包往返', async () => {
    service.close();
    service = new SessionArchiveService({
      sessionsDir,
      archivesDir,
      store,
      schedules,
      knowledge,
      wireDumpDir,
      includeLlmDumps: true,
      now: () => FIXED_NOW,
    });
    await makeSession('s1');
    await service.seal({ sessionId: 's1', state: 'trashed', sealedBy: 'trash' });
    expect(existsSync(join(wireDumpDir, 's1'))).toBe(false);
    const manifest = await readBundleManifest(join(archivesDir, 'sessions', 's1.tar.gz'));
    expect(manifest.files.some((f) => f.path === 'llm-dumps/req.json')).toBe(true);
    await service.restore('s1');
    expect(await readFile(join(wireDumpDir, 's1', 'req.json'), 'utf-8')).toBe('{"wire":1}');
  });
});

describe('purge（彻底删除）', () => {
  it('包/dump/注册表零残留', async () => {
    await makeSession('s1');
    await service.seal({ sessionId: 's1', state: 'trashed', sealedBy: 'trash' });
    const { purged } = await service.purge('s1');
    expect(purged).toEqual(['s1']);
    expect(existsSync(join(archivesDir, 'sessions', 's1.tar.gz'))).toBe(false);
    expect(existsSync(join(wireDumpDir, 's1'))).toBe(false);
    expect(service.list()).toHaveLength(0);
  });

  it('组级 ready 守卫：混相组（sealing 兄弟）整组拒销，包不陪葬', async () => {
    await makeSession('p');
    await makeSession('c1', { spawnParent: 'p' });
    await service.seal({
      sessionId: 'p',
      state: 'trashed',
      sealedBy: 'trash',
      groupSessionIds: ['c1'],
    });
    // 伪造组封存中途崩、reconcile 未结清：c1 行降回 sealing（正文可能只在 staging）
    const raw = new ArchiveRegistry(join(archivesDir, 'archives.db'));
    raw.setPhase('c1', 'sealing');
    raw.close();
    await expect(service.purge('p')).rejects.toThrow(/entry_not_ready/);
    await expect(service.purge('c1')).rejects.toThrow(/entry_not_ready/);
    // 拒销后包与注册表行原样在（reconcile 可继续结清）
    expect(existsSync(join(archivesDir, 'sessions', 'p.tar.gz'))).toBe(true);
    expect(service.list()).toHaveLength(2);
  });
});

describe('级联组（spawnBy）', () => {
  it('seal/restore/purge 整组共进退', async () => {
    await makeSession('p');
    await makeSession('c1', { spawnParent: 'p' });
    const { sealed } = await service.seal({
      sessionId: 'p',
      state: 'trashed',
      sealedBy: 'trash',
      groupSessionIds: ['c1'],
    });
    expect(sealed.map((s) => s.sessionId).sort()).toEqual(['c1', 'p']);
    expect(new Set(sealed.map((s) => s.groupSealId)).size).toBe(1);
    expect(service.list('trashed')).toHaveLength(2);

    // 从子会话 id 恢复 → 整组回
    await service.restore('c1');
    expect(service.list()).toHaveLength(0);
    expect(existsSync(join(sessionsDir, 'p.jsonl'))).toBe(true);
    expect(existsSync(join(sessionsDir, 'c1.jsonl'))).toBe(true);

    // 再封存后从子会话 purge → 整组销毁
    await service.seal({
      sessionId: 'p',
      state: 'trashed',
      sealedBy: 'trash',
      groupSessionIds: ['c1'],
    });
    await service.purge('c1');
    expect(service.list()).toHaveLength(0);
    expect(existsSync(join(archivesDir, 'sessions', 'p.tar.gz'))).toBe(false);
    expect(existsSync(join(archivesDir, 'sessions', 'c1.tar.gz'))).toBe(false);
  });
});

describe('崩溃矩阵 reconcile（不丢正文）', () => {
  it('旁车在、搬迁中崩 → reconcile 续封成功', async () => {
    await makeSession('s1');
    // 注入崩溃：store.delete 第一次抛（模拟搬迁前进程死）
    const flaky: SessionArchiveStorePort = Object.create(store);
    let fail = true;
    flaky.delete = async (id, options) => {
      if (fail) {
        fail = false;
        throw new Error('simulated crash');
      }
      return store.delete(id, options);
    };
    const svc = makeService(flaky);
    await expect(
      svc.seal({ sessionId: 's1', state: 'trashed', sealedBy: 'trash' }),
    ).rejects.toThrow('simulated crash');
    // 现场：行=sealing + 旁车在
    expect(svc.list()[0]?.phase).toBe('sealing');

    const report = await svc.reconcile();
    expect(report.completedSeals).toEqual(['s1']);
    expect(svc.list()[0]?.phase).toBe('ready');
    expect(existsSync(join(archivesDir, 'sessions', 's1.tar.gz'))).toBe(true);
    expect(existsSync(join(sessionsDir, 's1.jsonl'))).toBe(false); // 正文已在包里
    svc.close();
  });

  it('意图空账（旁车/包/staging 全空）→ 撤行，热库不动', async () => {
    await makeSession('s2');
    const raw = new ArchiveRegistry(join(archivesDir, 'archives.db'));
    raw.upsert({
      sessionId: 's2',
      groupSealId: 's2',
      parentSessionId: null,
      tenantId: 'default',
      agentId: 'a1',
      title: 's2',
      state: 'trashed',
      phase: 'sealing',
      sealedBy: 'trash',
      createdAt: 1,
      endedAt: null,
      sealedAt: FIXED_NOW,
      purgeAt: FIXED_NOW + 30 * DAY_MS,
      bundle: 'sessions/s2.tar.gz',
      bytes: 0,
      messageCount: 0,
      manifestJson: '{}',
    });
    raw.close();

    const report = await service.reconcile();
    expect(report.droppedRows).toEqual(['s2']);
    expect(service.list()).toHaveLength(0);
    expect(existsSync(join(sessionsDir, 's2.jsonl'))).toBe(true); // 什么都没发生
  });

  it('sealing + 包在 + staging 残留（就绪前崩）→ 补就绪并清残留', async () => {
    await makeSession('s3');
    await service.seal({ sessionId: 's3', state: 'trashed', sealedBy: 'trash' });
    // 伪造“就绪前崩”现场：行改回 sealing + staging 残留
    const raw = new ArchiveRegistry(join(archivesDir, 'archives.db'));
    raw.setPhase('s3', 'sealing');
    raw.close();
    await mkdir(join(archivesDir, '.staging', 's3'), { recursive: true });
    await writeFile(join(archivesDir, '.staging', 's3', 'residue.txt'), 'x');

    const report = await service.reconcile();
    expect(report.completedSeals).toEqual(['s3']);
    expect(service.list()[0]?.phase).toBe('ready');
    expect(existsSync(join(archivesDir, '.staging', 's3'))).toBe(false);
  });

  it('restoring 中崩 → reconcile 续恢复', async () => {
    await makeSession('s4');
    await service.seal({ sessionId: 's4', state: 'trashed', sealedBy: 'trash' });
    const raw = new ArchiveRegistry(join(archivesDir, 'archives.db'));
    raw.setPhase('s4', 'restoring');
    raw.close();

    const report = await service.reconcile();
    expect(report.completedRestores).toEqual(['s4']);
    expect(existsSync(join(sessionsDir, 's4.jsonl'))).toBe(true);
    expect(service.list()).toHaveLength(0);
  });

  it('row=ready 但 staging 残留（就绪后清场崩）→ 尾扫清除', async () => {
    await makeSession('s6', { withDump: false });
    await service.seal({ sessionId: 's6', state: 'trashed', sealedBy: 'trash' });
    // 伪造“就绪入账后、清场前崩”现场：staging + 旁车残留（row 已 ready）
    await mkdir(join(archivesDir, '.staging', 's6'), { recursive: true });
    await writeFile(join(archivesDir, '.staging', 's6', 'residue.txt'), 'x');
    await writeFile(join(archivesDir, '.staging', 's6.seal.json'), '{"version":1}');
    const report = await service.reconcile();
    expect(report.warnings).toEqual([]);
    expect(existsSync(join(archivesDir, '.staging', 's6'))).toBe(false);
    expect(existsSync(join(archivesDir, '.staging', 's6.seal.json'))).toBe(false);
    expect(service.list('trashed')[0]?.phase).toBe('ready');
  });

  it('恢复撞 id 复用 → 拒绝（不混合新旧数据，包保持可恢复）', async () => {
    await makeSession('s7', { withDump: false });
    await service.seal({ sessionId: 's7', state: 'trashed', sealedBy: 'trash' });
    // id 被复用：热库出现同 id 新会话
    await makeSession('s7', { withDump: false });
    await expect(service.restore('s7')).rejects.toThrow(/session_id_conflict/);
    expect(service.list('trashed')).toHaveLength(1); // 拒绝不破坏回收站
  });

  it('staging 有数据但旁车缺失 → 不动现场 + 警告（交 doctor）', async () => {
    await mkdir(join(archivesDir, '.staging', 's5'), { recursive: true });
    await writeFile(join(archivesDir, '.staging', 's5', 'orphan.jsonl'), 'data');
    const raw = new ArchiveRegistry(join(archivesDir, 'archives.db'));
    raw.upsert({
      sessionId: 's5',
      groupSealId: 's5',
      parentSessionId: null,
      tenantId: 'default',
      agentId: 'a1',
      title: 's5',
      state: 'trashed',
      phase: 'sealing',
      sealedBy: 'trash',
      createdAt: 1,
      endedAt: null,
      sealedAt: FIXED_NOW,
      purgeAt: null,
      bundle: 'sessions/s5.tar.gz',
      bytes: 0,
      messageCount: 0,
      manifestJson: '{}',
    });
    raw.close();

    const report = await service.reconcile();
    expect(report.warnings.some((w) => w.includes('s5'))).toBe(true);
    expect(existsSync(join(archivesDir, '.staging', 's5', 'orphan.jsonl'))).toBe(true);
    expect(service.list()[0]?.phase).toBe('sealing'); // 现场未动
  });
});

describe('runRetention', () => {
  it('到期 trashed 整组销毁；未过期不动；recent 超期只提名候选（封存走组级流程）', async () => {
    await makeSession('expired', { withDump: false });
    await makeSession('fresh', { withDump: false });
    await makeSession('recent-old', { lifecycle: 'recent', endedAt: FIXED_NOW - 40 * DAY_MS, withDump: false });
    await service.seal({ sessionId: 'expired', state: 'trashed', sealedBy: 'trash' });
    await service.seal({ sessionId: 'fresh', state: 'trashed', sealedBy: 'trash' });

    const report = await service.runRetention(FIXED_NOW + 31 * DAY_MS);
    expect(report.purged.sort()).toEqual(['expired', 'fresh'].sort()); // 31d > 30d TTL，两者都到期
    // 自动冷归档只提名候选（关账/级联/广播在组合侧；服务不代封存 —— 评审 major-3）
    expect(report.autoArchiveCandidates).toEqual(['recent-old']);
    expect(await store.load('recent-old')).not.toBeNull(); // 仍在热库
    expect(service.list().map((e) => e.sessionId)).toEqual([]);

    // 模拟组合侧执行组封存后带 180d 存期（sealedAt 取服务时钟）
    await service.seal({ sessionId: 'recent-old', state: 'archived', sealedBy: 'auto' });
    expect(service.list()[0]).toMatchObject({ state: 'archived', sealedBy: 'auto' });
    expect(service.list()[0]?.purgeAt).toBe(FIXED_NOW + 180 * DAY_MS);
    expect(existsSync(join(sessionsDir, 'recent-old.jsonl'))).toBe(false);
  });
});

describe('评审回归（blocker/major 防线）', () => {
  it('非 ready 行拒绝 trash/restore/purge（entry_not_ready，护住 staging 唯一副本）', async () => {
    await makeSession('nr', { withDump: false });
    // 伪造 sealing 失败现场：行=sealing、正文只在 staging、包不存在
    const flaky: SessionArchiveStorePort = Object.create(store);
    let fail = true;
    flaky.delete = async (id, options) => {
      if (fail) {
        fail = false;
        throw new Error('simulated crash');
      }
      return store.delete(id, options);
    };
    const svc = makeService(flaky);
    await expect(svc.seal({ sessionId: 'nr', state: 'trashed', sealedBy: 'trash' })).rejects.toThrow();
    expect(svc.list()[0]?.phase).toBe('sealing');

    await expect(svc.trash('nr')).rejects.toThrow(/entry_not_ready/);
    await expect(svc.restore('nr')).rejects.toThrow(/entry_not_ready/);
    await expect(svc.purge('nr')).rejects.toThrow(/entry_not_ready/);
    // staging 唯一副本仍在（未被误销毁）
    expect(existsSync(join(archivesDir, '.staging', 'nr.seal.json'))).toBe(true);
    // TTL 自动销毁不命中未就绪行
    const report = await svc.runRetention(FIXED_NOW + 365 * DAY_MS);
    expect(report.purged).toEqual([]);
    svc.close();
  });

  it('并发双 seal 同一会话：串行后一成功一失败，包 unharmed', async () => {
    await makeSession('cc', { withDump: false });
    const results = await Promise.allSettled([
      service.seal({ sessionId: 'cc', state: 'trashed', sealedBy: 'trash' }),
      service.seal({ sessionId: 'cc', state: 'trashed', sealedBy: 'trash' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1); // 第二个：会话已被第一个封走（not found），不是打出坏包
    const manifest = await readBundleManifest(join(archivesDir, 'sessions', 'cc.tar.gz'));
    expect(manifest.sessionId).toBe('cc');
  });

  it('恢复尾崩（包/staging 已删、行在、热库完整）→ 恢复请求补清行即成功', async () => {
    await makeSession('pc', { withDump: false });
    await service.seal({ sessionId: 'pc', state: 'trashed', sealedBy: 'trash' });
    // 伪造尾崩现场：文件已回热库、包已删、行未删（restoreInternal step 6 后崩）
    const staging = join(archivesDir, '.staging', 'restore-pc');
    await rm(join(archivesDir, 'sessions', 'pc.tar.gz'), { force: true });
    await rm(staging, { recursive: true, force: true });
    const raw = new ArchiveRegistry(join(archivesDir, 'archives.db'));
    raw.setPhase('pc', 'restoring');
    raw.close();
    await store.save('pc', {
      id: 'pc',
      agentId: 'a1',
      messages: [{ role: 'user', content: 'back' }],
      meta: { id: 'pc', tenantId: 'default', agentId: 'a1', title: '会话 pc', createdAt: 4242 },
      metadata: { title: '会话 pc' },
      tasks: [],
    } as unknown as SessionData);

    const report = await service.reconcile();
    expect(report.completedRestores).toEqual(['pc']);
    expect(service.list()).toHaveLength(0); // 幻影行已清
    expect(await store.load('pc')).not.toBeNull();
  });

  it('wire dump 目录名 sanitize 与写入侧同源（id 含 @ 等字符）', async () => {
    const id = 'o9cq80xZiYC981bd7uTerivcj408@im.wechat';
    await makeSession(id);
    // 写入侧命名（wire-dump.ts sanitizeSessionDirName）：@ → _
    expect(existsSync(join(wireDumpDir, 'o9cq80xZiYC981bd7uTerivcj408_im.wechat'))).toBe(true);
    await service.seal({ sessionId: id, state: 'trashed', sealedBy: 'trash' });
    // 缺省直删必须真的删到（之前按原始 id 找不到目录 → 隐私残留）
    expect(existsSync(join(wireDumpDir, 'o9cq80xZiYC981bd7uTerivcj408_im.wechat'))).toBe(false);
  });

  it('run 事件归档 <sid>.events.jsonl 随包封存/恢复/清除（评审 major-5）', async () => {
    await makeSession('ev', { withDump: false });
    await writeFile(join(sessionsDir, 'ev.events.jsonl'), '{"type":"run_start"}\n');

    await service.seal({ sessionId: 'ev', state: 'trashed', sealedBy: 'trash' });
    expect(existsSync(join(sessionsDir, 'ev.events.jsonl'))).toBe(false); // 不残留热库
    const manifest = await readBundleManifest(join(archivesDir, 'sessions', 'ev.tar.gz'));
    expect(manifest.files.some((f) => f.path === 'events.jsonl')).toBe(true);

    await service.restore('ev');
    expect(await readFile(join(sessionsDir, 'ev.events.jsonl'), 'utf-8')).toBe('{"type":"run_start"}\n');

    await service.seal({ sessionId: 'ev', state: 'trashed', sealedBy: 'trash' });
    await service.purge('ev');
    expect(existsSync(join(sessionsDir, 'ev.events.jsonl'))).toBe(false); // purge 零残留
  });

  it('restore 前 manifest 身份校验：包与行不匹配拒绝（不把 B 的转录写进 A）', async () => {
    await makeSession('ia', { withDump: false });
    await makeSession('ib', { withDump: false });
    await service.seal({ sessionId: 'ia', state: 'trashed', sealedBy: 'trash' });
    await service.seal({ sessionId: 'ib', state: 'trashed', sealedBy: 'trash' });
    // 手工互换两个包（模拟误换包）：行的 manifestJson 与包内容 sessionId 不再一致
    const a = join(archivesDir, 'sessions', 'ia.tar.gz');
    const b = join(archivesDir, 'sessions', 'ib.tar.gz');
    const tmp = join(archivesDir, 'sessions', 'swap.tmp');
    await rename(a, tmp);
    await rename(b, a);
    await rename(tmp, b);
    await expect(service.restore('ia')).rejects.toThrow(/bundle_manifest_invalid|sha256|manifest/);
  });
});
