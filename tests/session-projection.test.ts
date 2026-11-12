/**
 * P1-1 检索投影收口（service-topology-p1.md §3 A）：投影单写者=gateway 门面。
 *
 * 锚（防复发）：
 * ① 零消息会话创建即入投影——不再依赖 run boot 对齐（OP-P0B-1 ② 验收判据）；
 * ② run 写后 `session_saved` 通知节流补投影（窗口内合并，写者唯一）；
 * ③ `session_removed` 删投影行；
 * ④ 投影失败不阻断权威写（I2：可重建非权威，降级 warn）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Gateway } from '../packages/gateway/src/gateway/gateway.js';
import type { AgentDefinition } from '../packages/engine/src/harness/shared/types/agent-definition.js';
import { createSqliteSessionIndex } from '../packages/engine/src/integration/storage/session-index.js';
import type { SessionIndexBackend } from '../packages/engine/src/integration/storage/session-index.js';

function makeAgent(id: string): AgentDefinition {
  return {
    id,
    home: '',
    workspace: '',
    persona: { name: id, description: '', systemPrompt: 'test' },
    tools: { allow: ['*'] },
    model: { provider: 'openai', model: 'gpt-5-mini' },
  };
}

type NotifyCapable = {
  handleRunHostNotify: (n: unknown, instanceId: string) => Promise<void>;
  sessionIndex?: SessionIndexBackend;
};

describe('P1-1 检索投影收口（单写者=gateway 门面）', () => {
  let home: string;
  const saved = process.env.OCTOPI_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'octopi-projection-'));
    process.env.OCTOPI_HOME = home;
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.OCTOPI_HOME;
    else process.env.OCTOPI_HOME = saved;
    await rm(home, { recursive: true, force: true });
  });

  /** 不 start()（避免拉子进程/端口）：只解析默认 store + 投影装配 */
  async function makeGateway(): Promise<Gateway> {
    const gateway = new Gateway({
      agents: [makeAgent('assistant')],
      knowledge: { service: { manageLocal: false } },
    });
    await (gateway as unknown as { ensureStore(): Promise<void> }).ensureStore();
    return gateway;
  }

  async function openReader(): Promise<SessionIndexBackend> {
    const reader = await createSqliteSessionIndex({ dbPath: join(home, 'sessions.index.db') });
    await reader.ensureSchema();
    return reader;
  }

  it('①-injected 注入 store 路径也投影（MAJ-1 回归锚：生产组合根形态）', async () => {
    // daemon.ts:1022 的生产形态 = new Gateway(config, 注入 store)——投影门面必须
    // 与 store 来源解耦（旧实现只挂默认工厂，生产零投影=回归）
    const { InMemorySessionStore } = await import(
      '../packages/engine/src/integration/storage/memory.js'
    );
    const gateway = new Gateway(
      { agents: [makeAgent('assistant')], knowledge: { service: { manageLocal: false } } },
      new InMemorySessionStore(),
    );
    await (gateway as unknown as { ensureStore(): Promise<void> }).ensureStore();
    await gateway.createSession({ agentId: 'assistant', sessionId: 's-injected' });

    const reader = await openReader();
    try {
      expect(await reader.countSessions()).toBe(1);
    } finally {
      reader.close();
    }
  });

  it('① 零消息会话创建即入投影（不等 boot 对齐）', async () => {
    const gateway = await makeGateway();
    await gateway.createSession({ agentId: 'assistant', sessionId: 's-zero' });

    const reader = await openReader();
    try {
      expect(await reader.countSessions()).toBe(1);
    } finally {
      reader.close();
    }
  });

  it('② run 写后 session_saved 通知补投影；节流窗口内合并为一次 upsert', async () => {
    const gateway = await makeGateway();
    await gateway.createSession({ agentId: 'assistant', sessionId: 's-run' });

    const seam = gateway as unknown as NotifyCapable;
    // 人为清掉投影行，模拟 run 写后投影缺失（补差链路的最小可验形态）
    const reader = await openReader();
    await reader.remove('s-run');
    expect(await reader.countSessions()).toBe(0);
    reader.close();

    // 节流 spy：窗口内多次通知只允许一次 upsert
    let upserts = 0;
    const real = seam.sessionIndex;
    if (!real) throw new Error('sessionIndex missing on default store (projection not wired)');
    seam.sessionIndex = {
      ...real,
      upsertFromSession: async (id: string, data) => {
        upserts += 1;
        await real.upsertFromSession(id, data);
      },
      remove: (id: string) => real.remove(id),
      close: () => real.close(),
    };

    await seam.handleRunHostNotify({ type: 'session_saved', sessionId: 's-run' }, 'inst-1');
    await seam.handleRunHostNotify({ type: 'session_saved', sessionId: 's-run' }, 'inst-1');
    // 立即分支是 fire-and-forget：等它落盘；第二次通知已并入节流 timer（3s 后才跑）
    await new Promise((r) => setTimeout(r, 50));

    const reader2 = await openReader();
    try {
      expect(await reader2.countSessions()).toBe(1); // 补差成功
      expect(upserts).toBe(1); // 节流合并：两次通知仅立即分支一次落盘，其余并入 timer
    } finally {
      reader2.close();
    }
  });

  it('③ session_removed 删投影行', async () => {
    const gateway = await makeGateway();
    await gateway.createSession({ agentId: 'assistant', sessionId: 's-del' });

    const seam = gateway as unknown as NotifyCapable;
    await seam.handleRunHostNotify({ type: 'session_removed', sessionId: 's-del' }, 'inst-1');

    const reader = await openReader();
    try {
      expect(await reader.countSessions()).toBe(0);
    } finally {
      reader.close();
    }
  });

  it('④ 投影失败不阻断权威写（I2 降级：save 仍成功）', async () => {
    const gateway = await makeGateway();
    const seam = gateway as unknown as NotifyCapable;
    // 先解析默认 store（含投影装配），再把投影砸坏——save 必须照常成功
    await gateway.createSession({ agentId: 'assistant', sessionId: 's-ok' });
    seam.sessionIndex?.close(); // 投影已关：后续 upsert 必抛——正是要验证的失败面

    await expect(
      gateway.createSession({ agentId: 'assistant', sessionId: 's-after-fail' }),
    ).resolves.toBeDefined();

    // 权威侧两个会话都在（store 层事实，不依赖投影）
    const sessions = await gateway.listSessions('assistant');
    expect(sessions.map((s) => s.id).sort()).toEqual(['s-after-fail', 's-ok']);
  });
});
