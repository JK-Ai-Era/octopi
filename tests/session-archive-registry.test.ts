/**
 * 归档注册表（archives.db）—— 行为契约
 *
 * - upsert/get/list/remove 往返与幂等覆盖
 * - phase 流转（sealing/ready/restoring）与 listUnsettled
 * - 到期查询 listExpiredTrashed（组内同 purgeAt）
 * - listByGroup 组查询
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveRegistry, type ArchiveRecord } from '@octopi-agent/engine/integration/storage/archives/registry.js';

let root: string;
let registry: ArchiveRegistry;

function rec(overrides: Partial<ArchiveRecord> = {}): ArchiveRecord {
  return {
    sessionId: 's1',
    groupSealId: 's1',
    parentSessionId: null,
    tenantId: 'default',
    agentId: 'a1',
    title: '会话一',
    state: 'trashed',
    phase: 'sealing',
    sealedBy: 'trash',
    createdAt: 1000,
    endedAt: 2000,
    sealedAt: 3000,
    purgeAt: 9000,
    bundle: 'sessions/s1.tar.gz',
    bytes: 123,
    messageCount: 7,
    manifestJson: '{"format":1}',
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'octopi-registry-'));
  registry = new ArchiveRegistry(join(root, 'archives.db'));
});

afterEach(async () => {
  registry.close();
  await rm(root, { recursive: true, force: true });
});

describe('ArchiveRegistry', () => {
  it('upsert → get 往返（null 字段保真）', () => {
    registry.upsert(rec());
    const got = registry.get('s1');
    expect(got).toEqual(rec());
    expect(registry.get('missing')).toBeNull();
  });

  it('同 sessionId upsert 幂等覆盖', () => {
    registry.upsert(rec());
    registry.upsert(rec({ state: 'archived', purgeAt: null, sealedBy: 'manual', phase: 'ready' }));
    expect(registry.get('s1')).toEqual(
      rec({ state: 'archived', purgeAt: null, sealedBy: 'manual', phase: 'ready' }),
    );
    expect(registry.list()).toHaveLength(1);
  });

  it('phase 流转 + listUnsettled', () => {
    registry.upsert(rec());
    expect(registry.listUnsettled().map((r) => r.sessionId)).toEqual(['s1']);
    registry.setPhase('s1', 'ready');
    expect(registry.listUnsettled()).toEqual([]);
    registry.setPhase('s1', 'restoring');
    expect(registry.listUnsettled().map((r) => r.phase)).toEqual(['restoring']);
  });

  it('setState 更新状态与到期时间', () => {
    registry.upsert(rec({ state: 'archived', purgeAt: null }));
    registry.setState('s1', 'trashed', 9000);
    const got = registry.get('s1');
    expect(got?.state).toBe('trashed');
    expect(got?.purgeAt).toBe(9000);
  });

  it('listExpiredTrashed：只列到期 trashed（含 purgeAt 边界）', () => {
    registry.upsert(rec({ sessionId: 'a', groupSealId: 'a', purgeAt: 100, phase: 'ready' }));
    registry.upsert(rec({ sessionId: 'b', groupSealId: 'b', purgeAt: 300, phase: 'ready' }));
    registry.upsert(rec({ sessionId: 'c', groupSealId: 'c', state: 'archived', purgeAt: 100, phase: 'ready' }));
    registry.upsert(rec({ sessionId: 'd', groupSealId: 'd', purgeAt: null, phase: 'ready' }));
    registry.upsert(rec({ sessionId: 'e', groupSealId: 'e', purgeAt: 100, phase: 'sealing' })); // 未就绪不进销毁候选
    expect(registry.listExpiredTrashed(200).map((r) => r.sessionId)).toEqual(['a']);
    expect(registry.listExpiredTrashed(300).map((r) => r.sessionId)).toEqual(['a', 'b']);
  });

  it('listByGroup：级联组共进退', () => {
    registry.upsert(rec({ sessionId: 'p', groupSealId: 'g1', parentSessionId: null }));
    registry.upsert(rec({ sessionId: 'c1', groupSealId: 'g1', parentSessionId: 'p' }));
    registry.upsert(rec({ sessionId: 'x', groupSealId: 'g2' }));
    expect(registry.listByGroup('g1').map((r) => r.sessionId).sort()).toEqual(['c1', 'p']);
  });

  it('list(state) 过滤 + sealed_at 倒序', () => {
    registry.upsert(rec({ sessionId: 'a', sealedAt: 100, state: 'trashed' }));
    registry.upsert(rec({ sessionId: 'b', sealedAt: 300, state: 'archived' }));
    registry.upsert(rec({ sessionId: 'c', sealedAt: 200, state: 'trashed' }));
    expect(registry.list('trashed').map((r) => r.sessionId)).toEqual(['c', 'a']);
    expect(registry.list().map((r) => r.sessionId)).toEqual(['b', 'c', 'a']);
    expect(registry.listReady().map((r) => r.sessionId)).toEqual([]); // 全部 sealing
  });

  it('remove 删除行', () => {
    registry.upsert(rec());
    registry.remove('s1');
    expect(registry.get('s1')).toBeNull();
  });
});
