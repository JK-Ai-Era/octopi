/**
 * SessionTaskService — 会话任务唯一写入口
 *
 * 职责：
 * - 读写 SessionData.tasks（经 SessionStore 持久化）
 * - 状态机校验与 goal 级联 drop
 * - 发射 session.task.* 事件
 *
 * Runner 在 load/create session 后必须 attachSession，使工具改到同一内存对象，
 * 避免 run 结束 save 覆盖工具写入。
 */

import { randomUUID } from 'node:crypto';
import type { SessionStore } from '../../core/interfaces/session-store.js';
import type { EventBus, AgentEvent } from '../../core/primitives/event-bus.js';
import type { SessionData } from '../session-types.js';
import type { SessionTask, SessionTaskStatus } from './types.js';
import { ACTIVE_SESSION_TASK_STATUSES } from './types.js';

export type SessionTaskCommandActor = 'agent' | 'system';

/** list 过滤 */
export interface SessionTaskListFilter {
  parentId?: string;
  status?: SessionTaskStatus;
  /** 仅未闭合（open + paused） */
  activeOnly?: boolean;
}

function now(): number {
  return Date.now();
}

function isActive(status: SessionTaskStatus): boolean {
  return ACTIVE_SESSION_TASK_STATUSES.includes(status);
}

/**
 * SessionTaskService
 */
export class SessionTaskService {
  /** Runner 挂载的活 session：key = agentId::sessionId */
  private live = new Map<string, SessionData>();

  constructor(
    private readonly store: SessionStore<SessionData>,
    private readonly events?: EventBus,
  ) {}

  /**
   * Runner 在 load/create 后调用，绑定同一 SessionData 引用。
   */
  attachSession(session: SessionData): void {
    if (!session.tasks) session.tasks = [];
    this.live.set(this.key(session.agentId, session.id), session);
  }

  /**
   * Runner 在异常路径可选调用；正常 handle 结束可不 detach（下轮会重新 attach）。
   */
  detachSession(agentId: string, sessionId: string): void {
    this.live.delete(this.key(agentId, sessionId));
  }

  private key(agentId: string, sessionId: string): string {
    return `${agentId}::${sessionId}`;
  }

  /** 确保 session.tasks 为数组并返回（窄化类型） */
  private ensureTasks(session: SessionData): SessionTask[] {
    if (!session.tasks) session.tasks = [];
    return session.tasks;
  }

  private async resolve(agentId: string, sessionId: string): Promise<SessionData> {
    const k = this.key(agentId, sessionId);
    const live = this.live.get(k);
    if (live) {
      this.ensureTasks(live);
      return live;
    }
    const loaded = await this.store.load(agentId, sessionId);
    if (!loaded) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.ensureTasks(loaded);
    this.live.set(k, loaded);
    return loaded;
  }

  private async persist(session: SessionData): Promise<void> {
    session.meta.updatedAt = now();
    await this.store.save(session.agentId, session.id, session);
  }

  private emitTaskEvent(
    type: string,
    session: SessionData,
    task: SessionTask,
    actor: SessionTaskCommandActor = 'agent',
  ): void {
    if (!this.events) return;
    const event: AgentEvent = {
      type,
      timestamp: now(),
      agentId: session.agentId,
      sessionId: session.id,
      data: {
        task: { ...task },
        actor,
      },
    };
    this.events.emit(event);
  }

  private emitSnapshot(session: SessionData): void {
    if (!this.events) return;
    const tasks = this.ensureTasks(session);
    this.events.emit({
      type: 'session.task.snapshot',
      timestamp: now(),
      agentId: session.agentId,
      sessionId: session.id,
      data: { tasks: tasks.map((t) => ({ ...t })) },
    });
  }

  private find(session: SessionData, taskId: string): SessionTask {
    const task = this.ensureTasks(session).find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  // ── 查询 ──

  list(agentId: string, sessionId: string, filter?: SessionTaskListFilter): SessionTask[] {
    const session = this.live.get(this.key(agentId, sessionId));
    if (!session) return [];
    return this.filterTasks(this.ensureTasks(session), filter);
  }

  async listAsync(
    agentId: string,
    sessionId: string,
    filter?: SessionTaskListFilter,
  ): Promise<SessionTask[]> {
    const session = await this.resolve(agentId, sessionId);
    return this.filterTasks(this.ensureTasks(session), filter);
  }

  /** 未闭合的 goal（无 parentId） */
  listActiveGoals(agentId: string, sessionId: string): SessionTask[] {
    return this.list(agentId, sessionId).filter(
      (t) => !t.parentId && isActive(t.status),
    );
  }

  private filterTasks(tasks: SessionTask[], filter?: SessionTaskListFilter): SessionTask[] {
    return tasks.filter((t) => {
      if (filter?.parentId !== undefined) {
        if (filter.parentId === '') {
          if (t.parentId) return false;
        } else if (t.parentId !== filter.parentId) {
          return false;
        }
      }
      if (filter?.status && t.status !== filter.status) return false;
      if (filter?.activeOnly && !isActive(t.status)) return false;
      return true;
    });
  }

  // ── 变更 ──

  async create(
    agentId: string,
    sessionId: string,
    description: string,
    parentId?: string,
  ): Promise<SessionTask> {
    const trimmed = description.trim();
    if (!trimmed) {
      throw new Error('Task description must not be empty');
    }
    const session = await this.resolve(agentId, sessionId);
    const tasks = this.ensureTasks(session);

    let order: number | undefined;
    if (parentId) {
      const goal = this.find(session, parentId);
      if (goal.parentId) {
        throw new Error(`Cannot nest step under step: ${parentId} (depth must be 1)`);
      }
      if (!isActive(goal.status)) {
        throw new Error(`Cannot add step to task in status ${goal.status}: ${parentId}`);
      }
      const siblings = tasks.filter((t) => t.parentId === parentId);
      order = siblings.length;
    }

    const task: SessionTask = {
      id: randomUUID(),
      description: trimmed,
      status: 'open',
      createdAt: now(),
      updatedAt: now(),
    };
    if (parentId) task.parentId = parentId;
    if (order !== undefined) task.order = order;

    tasks.push(task);
    await this.persist(session);
    this.emitTaskEvent('session.task.created', session, task);
    return { ...task };
  }

  /**
   * 一次为 goal 创建有序 step 列表。
   */
  async plan(agentId: string, sessionId: string, goalId: string, steps: string[]): Promise<SessionTask[]> {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('plan() requires a non-empty steps array');
    }
    const session = await this.resolve(agentId, sessionId);
    const tasks = this.ensureTasks(session);
    const goal = this.find(session, goalId);
    if (goal.parentId) {
      throw new Error(`plan() target must be a goal, not a step: ${goalId}`);
    }
    if (!isActive(goal.status)) {
      throw new Error(`Cannot plan steps on task in status ${goal.status}: ${goalId}`);
    }

    const created: SessionTask[] = [];
    const baseOrder = tasks.filter((t) => t.parentId === goalId).length;
    let i = 0;
    for (const raw of steps) {
      const description = String(raw ?? '').trim();
      if (!description) {
        throw new Error('plan() step description must not be empty');
      }
      const task: SessionTask = {
        id: randomUUID(),
        parentId: goalId,
        description,
        status: 'open',
        order: baseOrder + i,
        createdAt: now(),
        updatedAt: now(),
      };
      tasks.push(task);
      created.push(task);
      i++;
    }

    await this.persist(session);
    for (const t of created) {
      this.emitTaskEvent('session.task.created', session, t);
    }
    return created.map((t) => ({ ...t }));
  }

  async complete(
    agentId: string,
    sessionId: string,
    taskId: string,
    progressNote?: string,
  ): Promise<SessionTask> {
    const session = await this.resolve(agentId, sessionId);
    const task = this.find(session, taskId);

    if (task.status === 'done') {
      return { ...task }; // idempotent
    }
    if (task.status === 'dropped') {
      throw new Error(`Task already dropped and cannot be completed: ${taskId}`);
    }

    task.status = 'done';
    task.updatedAt = now();
    if (progressNote?.trim()) {
      task.progressNote = progressNote.trim();
    }

    await this.persist(session);
    this.emitTaskEvent('session.task.updated', session, task);
    return { ...task };
  }

  async pause(agentId: string, sessionId: string, taskId: string, reason?: string): Promise<SessionTask> {
    const session = await this.resolve(agentId, sessionId);
    const task = this.find(session, taskId);

    if (task.status === 'paused') {
      if (reason?.trim()) {
        task.progressNote = reason.trim();
        task.updatedAt = now();
        await this.persist(session);
        this.emitTaskEvent('session.task.updated', session, task);
      }
      return { ...task };
    }
    if (task.status !== 'open') {
      throw new Error(`Cannot pause task in status ${task.status}: ${taskId}`);
    }

    task.status = 'paused';
    task.updatedAt = now();
    if (reason?.trim()) {
      task.progressNote = reason.trim();
    }

    await this.persist(session);
    this.emitTaskEvent('session.task.updated', session, task);
    return { ...task };
  }

  async resume(agentId: string, sessionId: string, taskId: string): Promise<SessionTask> {
    const session = await this.resolve(agentId, sessionId);
    const task = this.find(session, taskId);

    if (task.status === 'open') {
      return { ...task };
    }
    if (task.status !== 'paused') {
      throw new Error(`Cannot resume task in status ${task.status}: ${taskId}`);
    }

    task.status = 'open';
    task.updatedAt = now();

    await this.persist(session);
    this.emitTaskEvent('session.task.updated', session, task);
    return { ...task };
  }

  async drop(
    agentId: string,
    sessionId: string,
    taskId: string,
    reason?: string,
    actor: SessionTaskCommandActor = 'agent',
  ): Promise<SessionTask> {
    const session = await this.resolve(agentId, sessionId);
    const tasks = this.ensureTasks(session);
    const task = this.find(session, taskId);

    if (task.status === 'dropped') {
      return { ...task };
    }
    if (task.status === 'done') {
      // 已完成再放弃：允许（用户反悔勾选），置为 dropped
    }

    task.status = 'dropped';
    task.updatedAt = now();
    if (reason?.trim()) {
      task.progressNote = reason.trim();
    }

    const cascaded: SessionTask[] = [];
    if (!task.parentId) {
      for (const child of tasks) {
        if (child.parentId === taskId && isActive(child.status)) {
          child.status = 'dropped';
          child.updatedAt = now();
          cascaded.push(child);
        }
      }
    }

    await this.persist(session);
    this.emitTaskEvent('session.task.updated', session, task, actor);
    for (const child of cascaded) {
      this.emitTaskEvent('session.task.updated', session, child, actor);
    }
    return { ...task };
  }

  async note(agentId: string, sessionId: string, taskId: string, progressNote: string): Promise<SessionTask> {
    const trimmed = progressNote.trim();
    if (!trimmed) {
      throw new Error('progress_note must not be empty');
    }
    const session = await this.resolve(agentId, sessionId);
    const task = this.find(session, taskId);
    task.progressNote = trimmed;
    task.updatedAt = now();
    await this.persist(session);
    this.emitTaskEvent('session.task.updated', session, task);
    return { ...task };
  }

  /**
   * 打开会话时发 snapshot（供 UI）。
   */
  async emitSnapshotAsync(agentId: string, sessionId: string): Promise<void> {
    const session = await this.resolve(agentId, sessionId);
    this.emitSnapshot(session);
  }
}
