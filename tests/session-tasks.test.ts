/**
 * SessionTaskService / 注入渲染 / 工具 — 行为测试
 * 规格：docs/task-system.md
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySessionStore } from '../src/integration/storage/memory.js';
import { SessionTaskService } from '../src/harness/session-tasks/service.js';
import { renderSessionTasksInjection } from '../src/harness/session-tasks/render.js';
import { createSessionTaskTools } from '../src/harness/session-tasks/tools.js';
import type { SessionData } from '../src/harness/session-types.js';
import type { AgentEvent } from '../src/core/primitives/event-bus.js';
import type { EventBus } from '../src/core/primitives/event-bus.js';

function createSession(id = 's1', agentId = 'a1'): SessionData {
  return {
    id,
    agentId,
    meta: {
      id,
      agentId,
      channelId: 'test',
      peerId: 'test',
      status: 'idle',
      createdAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
    turns: [],
    metadata: {},
    tasks: [],
  };
}

function createBus() {
  const events: AgentEvent[] = [];
  const bus: EventBus = {
    emit(event) {
      events.push(event);
    },
    on() {
      return { dispose() {} };
    },
    once() {
      return { dispose() {} };
    },
    off() {},
    removeAllListeners() {},
  } as unknown as EventBus;
  return { bus, events };
}

describe('SessionTaskService', () => {
  let store: InMemorySessionStore;
  let service: SessionTaskService;
  let events: AgentEvent[];
  const agentId = 'a1';
  const sessionId = 's1';

  beforeEach(async () => {
    store = new InMemorySessionStore();
    const { bus, events: ev } = createBus();
    events = ev;
    service = new SessionTaskService(store, bus);
    const session = createSession(sessionId, agentId);
    await store.save(sessionId, session);
    service.attachSession(session);
  });

  it('创建 goal 并持久化', async () => {
    const task = await service.create(agentId, sessionId, '分析代码质量');
    expect(task.status).toBe('open');
    expect(task.parentId).toBeUndefined();

    const loaded = await store.load(sessionId);
    expect(loaded?.tasks).toHaveLength(1);
    expect(loaded?.tasks?.[0].id).toBe(task.id);
  });

  it('complete 后不再算活跃；再 complete 幂等', async () => {
    const t = await service.create(agentId, sessionId, '写报告');
    await service.complete(agentId, sessionId, t.id, '已写完');
    expect(service.listActiveGoals(agentId, sessionId)).toHaveLength(0);

    const again = await service.complete(agentId, sessionId, t.id);
    expect(again.status).toBe('done');
  });

  it('dropped 后 complete 报错', async () => {
    const t = await service.create(agentId, sessionId, '旧任务');
    await service.drop(agentId, sessionId, t.id);
    await expect(service.complete(agentId, sessionId, t.id)).rejects.toThrow(/dropped/i);
  });

  it('pause / resume', async () => {
    const t = await service.create(agentId, sessionId, '整理草稿');
    await service.pause(agentId, sessionId, t.id, '用户换话题');
    expect(service.listActiveGoals(agentId, sessionId)[0].status).toBe('paused');
    await service.resume(agentId, sessionId, t.id);
    expect(service.listActiveGoals(agentId, sessionId)[0].status).toBe('open');
  });

  it('task_plan 创建有序 step', async () => {
    const goal = await service.create(agentId, sessionId, '发布准备');
    const steps = await service.plan(agentId, sessionId, goal.id, ['写说明', '打 tag', '发公告']);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.order)).toEqual([0, 1, 2]);
    expect(steps.every((s) => s.parentId === goal.id)).toBe(true);
  });

  it('禁止 depth>1', async () => {
    const goal = await service.create(agentId, sessionId, '目标');
    const step = await service.create(agentId, sessionId, '步骤', goal.id);
    await expect(service.create(agentId, sessionId, '子步骤', step.id)).rejects.toThrow(/depth/i);
  });

  it('goal drop 级联 drop 未闭合 step', async () => {
    const goal = await service.create(agentId, sessionId, '长任务');
    const s1 = await service.create(agentId, sessionId, '步骤一', goal.id);
    const s2 = await service.create(agentId, sessionId, '步骤二', goal.id);
    await service.complete(agentId, sessionId, s1.id);

    await service.drop(agentId, sessionId, goal.id, '用户放弃');

    const all = await service.listAsync(agentId, sessionId);
    expect(all.find((t) => t.id === goal.id)?.status).toBe('dropped');
    expect(all.find((t) => t.id === s1.id)?.status).toBe('done'); // 已完成不级联
    expect(all.find((t) => t.id === s2.id)?.status).toBe('dropped');
  });

  it('全部 step done 不自动 complete goal', async () => {
    const goal = await service.create(agentId, sessionId, '交付');
    const steps = await service.plan(agentId, sessionId, goal.id, ['A', 'B']);
    for (const s of steps) {
      await service.complete(agentId, sessionId, s.id);
    }
    const g = (await service.listAsync(agentId, sessionId)).find((t) => t.id === goal.id);
    expect(g?.status).toBe('open');
  });

  it('attach 后工具写入与 runner 同一对象，不丢', async () => {
    const session = (await store.load(sessionId))!;
    // 模拟下一轮 runner 重新 load 并 attach 新对象
    const session2 = createSession(sessionId, agentId);
    session2.tasks = session.tasks;
    service.attachSession(session2);

    await service.create(agentId, sessionId, '插话后仍可见');
    expect(session2.tasks).toHaveLength(1);

    // runner 保存 session2，store 保留任务
    await store.save(sessionId, session2);
    const reloaded = await store.load(sessionId);
    expect(reloaded?.tasks).toHaveLength(1);
  });

  it('发射 session.task.created / updated', async () => {
    const t = await service.create(agentId, sessionId, '事件测试');
    await service.complete(agentId, sessionId, t.id);
    const types = events.map((e) => e.type);
    expect(types).toContain('session.task.created');
    expect(types).toContain('session.task.updated');
  });
});

describe('renderSessionTasksInjection', () => {
  it('无活跃 goal 返回空串', () => {
    expect(renderSessionTasksInjection([])).toBe('');
    expect(
      renderSessionTasksInjection([
        {
          id: '1',
          description: 'x',
          status: 'done',
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    ).toBe('');
  });

  it('goal + step rollup，不罗列全部 step', () => {
    const text = renderSessionTasksInjection([
      {
        id: 'g1',
        description: '分析代码质量',
        status: 'open',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 's1',
        parentId: 'g1',
        description: '扫描模块',
        status: 'done',
        order: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 's2',
        parentId: 'g1',
        description: '检查循环依赖',
        status: 'open',
        order: 1,
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 's3',
        parentId: 'g1',
        description: '生成报告',
        status: 'open',
        order: 2,
        createdAt: 3,
        updatedAt: 3,
      },
    ]);

    expect(text).toContain('<session_tasks>');
    expect(text).toContain('分析代码质量');
    expect(text).toContain('进度：步骤 1/3');
    expect(text).toContain('当前：检查循环依赖');
    // 第三个 step 描述不应出现在注入里（只 rollup 当前）
    expect(text).not.toContain('生成报告');
    expect(text).toContain('</session_tasks>');
  });
});

describe('task_* 工具', () => {
  let store: InMemorySessionStore;
  let service: SessionTaskService;

  beforeEach(async () => {
    store = new InMemorySessionStore();
    service = new SessionTaskService(store);
    const session = createSession('s1', 'a1');
    await store.save('s1', session);
    service.attachSession(session);
  });

  function tools() {
    const list = createSessionTaskTools(service);
    const byName = Object.fromEntries(list.map((t) => [t.definition.name, t]));
    return byName;
  }

  const ctx = { sessionId: 's1', agentId: 'a1', messages: [] };

  it('task_create / task_list / task_complete', async () => {
    const t = tools();
    const created = (await t.task_create.handler({ description: '用户级任务' }, ctx)) as {
      id: string;
      status: string;
    };
    expect(created.status).toBe('open');

    const listed = (await t.task_list.handler({}, ctx)) as { total: number };
    expect(listed.total).toBe(1);

    await t.task_complete.handler({ task_id: created.id }, ctx);
    const after = (await t.task_list.handler({ active_only: true }, ctx)) as { total: number };
    expect(after.total).toBe(0);
  });

  it('task_create 带 parent_id 建 step；错误带 message', async () => {
    const t = tools();
    const goal = (await t.task_create.handler({ description: '目标' }, ctx)) as { id: string };
    const step = (await t.task_create.handler(
      { description: '步骤', parent_id: goal.id },
      ctx,
    )) as { parent_id?: string };
    expect(step.parent_id).toBe(goal.id);

    await expect(
      t.task_complete.handler({ task_id: 'missing-id' }, ctx),
    ).rejects.toThrow(/not found/i);
  });

  it('task_plan', async () => {
    const t = tools();
    const goal = (await t.task_create.handler({ description: '编排' }, ctx)) as { id: string };
    const planned = (await t.task_plan.handler({ goal_id: goal.id, steps: ['一', '二'] }, ctx)) as {
      total: number;
    };
    expect(planned.total).toBe(2);
  });
});
