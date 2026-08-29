/**
 * TaskTracker — 任务状态管理（纯数据，无 LLM 依赖）
 *
 * 职责：
 * - CRUD 任务状态
 * - 持久化到 JSONL 文件（append-only）
 * - 查询活跃/中断任务
 *
 * 不做任何决策，只管状态。
 */

import { randomUUID } from 'node:crypto';
import { appendFile, readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, TaskEvent, TaskTracker as ITaskTracker } from './types.js';

export class TaskTracker implements ITaskTracker {
  /** 内存中的任务状态 */
  private tasks = new Map<string, Task>();
  /** 任务事件日志路径 */
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? join(process.cwd(), 'data', 'tasks');
  }

  // ================================================================
  // CRUD
  // ================================================================

  async create(sessionId: string, description: string): Promise<Task> {
    const task: Task = {
      id: randomUUID(),
      sessionId,
      description,
      status: 'in_progress',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.tasks.set(task.id, task);
    await this.appendEvent({
      action: 'create',
      taskId: task.id,
      sessionId,
      description,
      timestamp: task.createdAt,
    });

    return task;
  }

  async start(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'in_progress';
    task.updatedAt = Date.now();
    await this.appendEvent({
      action: 'start',
      taskId,
      sessionId: task.sessionId,
      timestamp: task.updatedAt,
    });
  }

  async interrupt(taskId: string, reason: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.status !== 'in_progress') return; // 只有进行中的才能被打断

    task.status = 'interrupted';
    task.updatedAt = Date.now();
    await this.appendEvent({
      action: 'interrupt',
      taskId,
      sessionId: task.sessionId,
      reason,
      timestamp: task.updatedAt,
    });
  }

  async resume(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.status !== 'interrupted') return; // 只有被中断的才能恢复

    task.status = 'in_progress';
    task.updatedAt = Date.now();
    await this.appendEvent({
      action: 'resume',
      taskId,
      sessionId: task.sessionId,
      timestamp: task.updatedAt,
    });
  }

  async complete(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'completed';
    task.updatedAt = Date.now();
    await this.appendEvent({
      action: 'complete',
      taskId,
      sessionId: task.sessionId,
      timestamp: task.updatedAt,
    });
  }

  async cancel(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'cancelled';
    task.updatedAt = Date.now();
    await this.appendEvent({
      action: 'cancel',
      taskId,
      sessionId: task.sessionId,
      timestamp: task.updatedAt,
    });
  }

  // ================================================================
  // 查询
  // ================================================================

  getBySession(sessionId: string): Task[] {
    return Array.from(this.tasks.values()).filter((t) => t.sessionId === sessionId);
  }

  getActiveTasks(sessionId: string): Task[] {
    return this.getBySession(sessionId).filter(
      (t) => t.status === 'in_progress' || t.status === 'interrupted',
    );
  }

  getInterruptedTasks(sessionId: string): Task[] {
    return this.getBySession(sessionId).filter((t) => t.status === 'interrupted');
  }

  get(taskId: string): Task | null {
    return this.tasks.get(taskId) ?? null;
  }

  // ================================================================
  // 持久化
  // ================================================================

  /**
   * 从 JSONL 文件恢复任务状态（session 启动时调用）
   */
  async loadSession(sessionId: string): Promise<void> {
    const filePath = this.getFilePath(sessionId);
    
    // 用 stat try/catch 替代 existsSync
    try {
      await stat(filePath);
    } catch {
      // 文件不存在，返回
      return;
    }

    try {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const events: TaskEvent[] = lines.map((l) => JSON.parse(l));

      // 重放事件，重建状态
      for (const event of events) {
        switch (event.action) {
          case 'create':
            if (event.description) {
              this.tasks.set(event.taskId, {
                id: event.taskId,
                sessionId: event.sessionId,
                description: event.description,
                status: 'in_progress',
                createdAt: event.timestamp,
                updatedAt: event.timestamp,
              });
            }
            break;
          case 'start': {
            const t = this.tasks.get(event.taskId);
            if (t) {
              t.status = 'in_progress';
              t.updatedAt = event.timestamp;
            }
            break;
          }
          case 'interrupt': {
            const t = this.tasks.get(event.taskId);
            if (t) {
              t.status = 'interrupted';
              t.updatedAt = event.timestamp;
            }
            break;
          }
          case 'resume': {
            const t = this.tasks.get(event.taskId);
            if (t) {
              t.status = 'in_progress';
              t.updatedAt = event.timestamp;
            }
            break;
          }
          case 'complete': {
            const t = this.tasks.get(event.taskId);
            if (t) {
              t.status = 'completed';
              t.updatedAt = event.timestamp;
            }
            break;
          }
          case 'cancel': {
            const t = this.tasks.get(event.taskId);
            if (t) {
              t.status = 'cancelled';
              t.updatedAt = event.timestamp;
            }
            break;
          }
        }
      }
    } catch {
      // 文件损坏，忽略
    }
  }

  /**
   * 追加事件到 JSONL 文件
   */
  private async appendEvent(event: TaskEvent): Promise<void> {
    const dir = join(this.dataDir, event.sessionId);
    await mkdir(dir, { recursive: true });

    const filePath = this.getFilePath(event.sessionId);
    await appendFile(filePath, JSON.stringify(event) + '\n');
  }

  private getFilePath(sessionId: string): string {
    return join(this.dataDir, sessionId, 'tasks.jsonl');
  }
}
