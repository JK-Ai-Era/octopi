/**
 * JsonlSessionStore 并发写回归锚（T5 演练实锤 2026-11-14）：
 * 两洞曾同存——(1) tmp 名 `pid+毫秒` 非按写唯一：同毫秒双写撞名，rename ENOENT
 * 或把半截文件 rename 进目标（静默损坏）；(2) `sessions.json` 元索引 RMW 只有
 * per-session 写队列：不同 session 的并发 save 读旧写旧丢条目。委派子会话 save
 * × SessionTitle 异步 updateMetadata 对撞即翻车（演练 2/3 红实录）。
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { TenantId } from '@octopi-agent/engine/harness/governance/registry/types.js';

function sessionData(id: string): SessionData {
  return {
    id,
    agentId: 'agent-x',
    tenantId: 'tenant-x' as TenantId,
    meta: {
      id,
      agentId: 'agent-x',
      channelId: 'chan',
      peerId: 'peer',
      status: 'idle',
      createdAt: 1,
      sessionStartedAt: 1,
      lastInteractionAt: 1,
      updatedAt: 1,
      tenantId: 'tenant-x' as TenantId,
    },
    messages: [],
    steps: [],
    metadata: {},
  };
}

describe('JsonlSessionStore 并发写（元索引 RMW + tmp 唯一性回归锚）', () => {
  it('多 session 并发 save：元索引条目一条不丢、无 rename ENOENT（25 轮对撞）', async () => {
    for (let round = 0; round < 25; round++) {
      const dir = mkdtempSync(join(tmpdir(), 'session-store-race-'));
      try {
        const store = new JsonlSessionStore({ sessionsDir: dir });
        const ids = ['s-1', 's-2', 's-3', 's-4'];
        await Promise.all(ids.map((id) => store.save(id, sessionData(id))));
        const listed = await store.list();
        expect(listed.map((m) => m.id).sort(), `round ${round}`).toEqual([...ids].sort());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('同 session 并发 save：per-session 写队列守卫既有语义（终态唯一、索引单条）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-store-race-'));
    try {
      const store = new JsonlSessionStore({ sessionsDir: dir });
      await Promise.all([
        store.save('s-x', sessionData('s-x')),
        store.save('s-x', sessionData('s-x')),
        store.save('s-x', sessionData('s-x')),
      ]);
      expect(await store.list()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('delete × save 并发：元索引不损坏、不吞他人条目、不复活已删条目（MAJ-1 回归锚）', async () => {
    for (let round = 0; round < 25; round++) {
      const dir = mkdtempSync(join(tmpdir(), 'session-store-race-'));
      try {
        const store = new JsonlSessionStore({ sessionsDir: dir });
        await store.save('s-x', sessionData('s-x'));
        await store.save('s-1', sessionData('s-1'));
        await Promise.all([
          store.delete('s-x'),
          store.save('s-2', sessionData('s-2')),
          store.save('s-3', sessionData('s-3')),
        ]);
        // list 不抛（旧状：截断写回 6ms 损坏整份元索引后全店拒写）；
        // s-2/s-3 不被 delete 的读旧写回吞掉；s-x 不复活
        expect((await store.list()).map((m) => m.id).sort()).toEqual(['s-1', 's-2', 's-3']);
        expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('updateMetadata × save 并发：元索引恒一致（T5 演练真实对撞对）', async () => {
    for (let round = 0; round < 25; round++) {
      const dir = mkdtempSync(join(tmpdir(), 'session-store-race-'));
      try {
        const store = new JsonlSessionStore({ sessionsDir: dir });
        await store.save('s-a', sessionData('s-a'));
        await Promise.all([
          store.updateMetadata('s-a', (m) => {
            m.title = 'renamed';
          }),
          store.save('s-b', sessionData('s-b')),
          store.save('s-c', sessionData('s-c')),
        ]);
        expect((await store.list()).map((m) => m.id).sort()).toEqual(['s-a', 's-b', 's-c']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('save × load 并发：load 恒见完整消息数、无半截转录（MAJ-2 回归锚）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-store-race-'));
    try {
      const store = new JsonlSessionStore({ sessionsDir: dir });
      const data = sessionData('s-big');
      const messages: SessionData['messages'] = Array.from({ length: 50 }, (_, i) => ({
        role: 'user' as const,
        content: `hi ${i}`,
        timestamp: i,
      }));
      data.messages = messages;
      await store.save('s-big', data);
      for (let round = 0; round < 30; round++) {
        const results = await Promise.all([
          store.save('s-big', data),
          store.load('s-big'),
          store.load('s-big'),
          store.load('s-big'),
        ]);
        // 旧状：截断式 writeFile 并发读 254/320 次读到 0 条消息（torn read）
        for (const loaded of results.slice(1)) {
          expect(loaded?.messages.length).toBe(50);
        }
      }
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
