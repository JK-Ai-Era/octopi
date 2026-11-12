/**
 * session/audit 租户键控（arch/multi-tenancy.md §4，T1c）。
 *
 * 覆盖：SessionData.tenantId 投影（meta index）/ list 双实现过滤（历史缺省
 * 'default'）/ createSession 缺省与显式 / AuditWriter 代打租户 + 分区路径。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import { InMemorySessionStore } from '@octopi-agent/engine/harness/session/in-memory-store.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { TenantId } from '@octopi-agent/core/types.js';
import { AuditReader } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/audit/reader.js';
import { AuditWriter } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/audit/writer.js';
import type { SubsystemRun } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/types.js';

function makeSession(id: string, tenantId?: string): SessionData {
  const tid = tenantId as TenantId | undefined;
  const now = Date.now();
  return {
    id,
    agentId: 'assistant',
    ...(tid ? { tenantId: tid } : {}),
    meta: {
      id,
      agentId: 'assistant',
      ...(tid ? { tenantId: tid } : {}),
      channelId: 'web',
      peerId: 'web-ui',
      status: 'idle',
      createdAt: now,
      sessionStartedAt: now,
      lastInteractionAt: now,
      updatedAt: now,
    },
    messages: [],
    steps: [],
    metadata: {},
    tasks: [],
  };
}

describe('JsonlSessionStore — tenantId 投影与过滤', () => {
  let dir: string;
  let store: JsonlSessionStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'octopi-tenant-'));
    store = new JsonlSessionStore({ sessionsDir: dir });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('save 后 meta index 携带 tenantId；按租户过滤互不可见', async () => {
    await store.save('s-a1', makeSession('s-a1', 'tenant-a'));
    await store.save('s-b1', makeSession('s-b1', 'tenant-b'));
    const a = await store.list({ tenantId: 'tenant-a' as TenantId });
    const b = await store.list({ tenantId: 'tenant-b' as TenantId });
    expect(a.map((m) => m.id)).toEqual(['s-a1']);
    expect(b.map((m) => m.id)).toEqual(['s-b1']);
    expect(a[0].tenantId).toBe('tenant-a');
  });

  it('历史缺省视作 default（兼容存量数据）', async () => {
    await store.save('s-legacy', makeSession('s-legacy')); // 无 tenantId
    const def = await store.list({ tenantId: 'default' as TenantId });
    expect(def.map((m) => m.id)).toEqual(['s-legacy']);
    expect((await store.list({ tenantId: 'tenant-a' as TenantId })).length).toBe(0);
    // 不带过滤 = 全量（管理面语义）
    expect((await store.list()).length).toBe(1);
  });
});

describe('InMemorySessionStore — tenantId 过滤（与 jsonl 同规则）', () => {
  it('过滤 + default 缺省', async () => {
    const store = new InMemorySessionStore();
    await store.save('s-a1', makeSession('s-a1', 'tenant-a'));
    await store.save('s-legacy', makeSession('s-legacy'));
    expect((await store.list({ tenantId: 'tenant-a' as TenantId })).map((m) => m.id)).toEqual(['s-a1']);
    expect((await store.list({ tenantId: 'default' as TenantId })).map((m) => m.id)).toEqual(['s-legacy']);
  });
});

describe('AuditWriter — 事件带租户 + 分区路径', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'octopi-audit-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const baseRun = (id: string): SubsystemRun =>
    ({
      id,
      subsystemId: 'memory.steward.govern',
      trigger: { source: 'test', timestamp: Date.now() },
      input: {} as SubsystemRun['input'],
      timestamp: Date.now(),
    }) as SubsystemRun;

  it('写入器分区带租户；记录代打 tenantId', async () => {
    const writer = new AuditWriter({ auditDir: dir, tenantId: 'tenant-a', agentId: 'assistant' });
    writer.write(baseRun('r1'));
    const tenantDir = join(dir, 'tenant-a', 'assistant', 'memory.steward.govern');
    const files = readdirSync(tenantDir);
    expect(files.length).toBe(1);
    const line = (await readFile(join(tenantDir, files[0]), 'utf-8')).trim();
    expect(JSON.parse(line).tenantId).toBe('tenant-a');
  });

  it('run 自带 tenantId 优先——**分区随记录租户**（MIN-3：分区≠记录破坏取证完整性）', async () => {
    const writer = new AuditWriter({ auditDir: dir, tenantId: 'tenant-a' });
    writer.write({ ...baseRun('r2'), tenantId: 'tenant-b' });
    const tenantDir = join(dir, 'tenant-b', 'memory.steward.govern');
    const files = readdirSync(tenantDir);
    expect(files.length).toBe(1);
    const line = (await readFile(join(tenantDir, files[0]), 'utf-8')).trim();
    expect(JSON.parse(line).tenantId).toBe('tenant-b');
  });

  it('均缺省时恒打 DEFAULT_TENANT_ID（事件必带租户）', async () => {
    const writer = new AuditWriter({ auditDir: dir });
    writer.write(baseRun('r3'));
    const tenantDir = join(dir, 'default', 'memory.steward.govern');
    const files = readdirSync(tenantDir);
    const line = (await readFile(join(tenantDir, files[0]), 'utf-8')).trim();
    expect(JSON.parse(line).tenantId).toBe('default');
  });

  it('reader 回读（MAJ-6 锚）：三段式按租户可读、跨租户不可见', async () => {
    const writer = new AuditWriter({ auditDir: dir, tenantId: 'tenant-a', agentId: 'assistant' });
    writer.write(baseRun('r4'));
    const reader = new AuditReader({ auditDir: dir });
    expect(reader.query({ tenantId: 'tenant-a' }).length).toBe(1);
    expect(reader.query({ tenantId: 'tenant-a', agentId: 'assistant' }).length).toBe(1);
    expect(reader.query({ tenantId: 'tenant-a', agentId: 'assistant', subsystemId: 'memory.steward.govern' }).length).toBe(1);
    expect(reader.query({ tenantId: 'tenant-b' }).length).toBe(0);
  });

  it('reader 兼容 legacy 两段布局（升级前数据，租户视作 default）', async () => {
    const legacyDir = join(dir, 'assistant', 'memory.steward.govern');
    mkdirSync(legacyDir, { recursive: true });
    const legacyRun = JSON.stringify({ ...baseRun('r5') });
    writeFileSync(join(legacyDir, '2026-11-13.jsonl'), legacyRun + '\n', 'utf-8');
    const reader = new AuditReader({ auditDir: dir });
    expect(reader.query({ agentId: 'assistant' }).length).toBe(1);
    expect(reader.query({ tenantId: 'default', agentId: 'assistant' }).length).toBe(1);
    expect(reader.query({ tenantId: 'tenant-a', agentId: 'assistant' }).length).toBe(0);
  });
});

describe('JsonlSessionStore — tenantId 往返（MAJ-1 锚）', () => {
  let dir: string;
  let store: JsonlSessionStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'octopi-tenant-rt-'));
    store = new JsonlSessionStore({ sessionsDir: dir });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('save→load→save 一轮往返后租户不丢、不被擦进 default', async () => {
    await store.save('s-rt', makeSession('s-rt', 'tenant-a'));
    const loaded = await store.load('s-rt');
    expect(loaded?.tenantId).toBe('tenant-a' as TenantId);
    await store.save('s-rt', loaded!);
    const again = await store.load('s-rt');
    expect(again?.tenantId).toBe('tenant-a' as TenantId);
    expect((await store.list({ tenantId: 'tenant-a' as TenantId })).map((m) => m.id)).toEqual(['s-rt']);
    expect((await store.list({ tenantId: 'default' as TenantId })).length).toBe(0);
  });

  it('updateMetadata 往返后租户同样不丢（state 字段集一致律）', async () => {
    await store.save('s-um', makeSession('s-um', 'tenant-a'));
    await store.updateMetadata?.('s-um', (m) => {
      m.note = 'x';
    });
    expect((await store.load('s-um'))?.tenantId).toBe('tenant-a' as TenantId);
  });
});
