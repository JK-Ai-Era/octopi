/**
 * TaskStage 测试 — 新架构 Task System
 */

import { describe, it, expect, vi } from 'vitest';
import { TaskTracker } from '../src/harness/tasks/tracker.js';
import { TaskManager } from '../src/harness/tasks/manager.js';
import { TaskStage } from '../src/harness/context/stages/task-stage.js';
import { applyDecision } from '../src/harness/tasks/shared.js';
import type { ModelProvider, LLMResponse } from '../src/core/interfaces/model-provider.js';
import type { StageContext } from '../src/harness/context/pipeline.js';
import type { Message } from '../src/core/types.js';

// ── Helper ──

function createMockProvider(response?: Partial<LLMResponse>): ModelProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        injectTaskContext: false,
        taskContext: '',
        interruptedTasks: [],
        newTask: null,
        completesTask: null,
        resumeTask: null,
        reason: 'No task related',
      }),
      model: 'mock',
      finishReason: 'stop',
      ...response,
    }),
    stream: async function* () {},
    isAvailable: async () => true,
  };
}

function createStageContext(messages: Message[], sessionId?: string): StageContext {
  return {
    messages,
    systemPrompt: 'You are a helpful assistant.',
    tools: [],
    estimatedTokens: 0,
    untrustedRanges: [],
    extra: sessionId ? { sessionId } : {},
  };
}

// ── TaskTracker 测试 ──

describe('TaskTracker', () => {
  it('应该创建任务', async () => {
    const tracker = new TaskTracker('/tmp/octopi-test-tasks-' + Date.now());
    const task = await tracker.create('session-1', '分析代码质量');

    expect(task.id).toBeDefined();
    expect(task.description).toBe('分析代码质量');
    expect(task.status).toBe('in_progress');
    expect(task.sessionId).toBe('session-1');
  });

  it('应该中断和恢复任务', async () => {
    const tracker = new TaskTracker('/tmp/octopi-test-tasks-' + Date.now());
    const task = await tracker.create('session-1', '分析代码');

    await tracker.interrupt(task.id, '用户发了新消息');
    expect(tracker.get(task.id)?.status).toBe('interrupted');

    await tracker.resume(task.id);
    expect(tracker.get(task.id)?.status).toBe('in_progress');
  });

  it('应该完成和取消任务', async () => {
    const tracker = new TaskTracker('/tmp/octopi-test-tasks-' + Date.now());
    const task1 = await tracker.create('session-1', '任务1');
    const task2 = await tracker.create('session-1', '任务2');

    await tracker.complete(task1.id);
    expect(tracker.get(task1.id)?.status).toBe('completed');

    await tracker.cancel(task2.id);
    expect(tracker.get(task2.id)?.status).toBe('cancelled');
  });

  it('应该查询活跃任务', async () => {
    const tracker = new TaskTracker('/tmp/octopi-test-tasks-' + Date.now());
    const task1 = await tracker.create('session-1', '任务1');
    const task2 = await tracker.create('session-1', '任务2');
    await tracker.complete(task1.id);

    const active = tracker.getActiveTasks('session-1');
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(task2.id);
  });

  it('应该查询被中断的任务', async () => {
    const tracker = new TaskTracker('/tmp/octopi-test-tasks-' + Date.now());
    const task1 = await tracker.create('session-1', '任务1');
    const task2 = await tracker.create('session-1', '任务2');
    await tracker.interrupt(task1.id, 'test');

    const interrupted = tracker.getInterruptedTasks('session-1');
    expect(interrupted.length).toBe(1);
    expect(interrupted[0].id).toBe(task1.id);
  });

  it('应该持久化和恢复', async () => {
    const dataDir = '/tmp/octopi-test-tasks-' + Date.now();
    const tracker1 = new TaskTracker(dataDir);
    await tracker1.create('session-1', '任务1');
    await tracker1.create('session-1', '任务2');

    // 新的 tracker 实例，从 JSONL 恢复
    const tracker2 = new TaskTracker(dataDir);
    await tracker2.loadSession('session-1');

    const tasks = tracker2.getActiveTasks('session-1');
    expect(tasks.length).toBe(2);
    expect(tasks[0].description).toBe('任务1');
    expect(tasks[1].description).toBe('任务2');
  });
});

// ── TaskManager 测试 ──

describe('TaskManager', () => {
  it('应该调用 LLM 做决策', async () => {
    const provider = createMockProvider({
      content: JSON.stringify({
        injectTaskContext: true,
        taskContext: '你有一个进行中的任务：分析代码',
        interruptedTasks: [],
        newTask: null,
        completesTask: null,
        resumeTask: null,
        reason: 'Task in progress',
      }),
    });

    const manager = new TaskManager(provider, 'mock-model');
    const decision = await manager.decide({
      sessionId: 'session-1',
      currentTasks: [{ id: 't1', sessionId: 'session-1', description: '分析代码', status: 'in_progress', createdAt: Date.now(), updatedAt: Date.now() }],
      newMessage: '继续',
      recentContext: '[user] 分析代码质量',
    });

    expect(decision.injectTaskContext).toBe(true);
    expect(decision.taskContext).toContain('分析代码');
  });

  it('LLM 调用失败时返回默认决策', async () => {
    const provider = createMockProvider();
    (provider.chat as any).mockRejectedValue(new Error('API error'));

    const manager = new TaskManager(provider, 'mock-model');
    const decision = await manager.decide({
      sessionId: 'session-1',
      currentTasks: [],
      newMessage: '你好',
      recentContext: '',
    });

    expect(decision.injectTaskContext).toBe(false);
    expect(decision.newTask).toBeNull();
  });
});

// ── applyDecision 测试 ──

describe('applyDecision', () => {
  it('应该中断任务', async () => {
    const tracker = new TaskTracker('/tmp/octopi-test-apply-' + Date.now());
    const task = await tracker.create('session-1', '任务1');

    await applyDecision(tracker, 'session-1', {
      injectTaskContext: false,
      taskContext: '',
      interruptedTasks: [task.id],
      newTask: null,
      completesTask: null,
      resumeTask: null,
      reason: '无关消息',
    });

    expect(tracker.get(task.id)?.status).toBe('interrupted');
  });

  it('应该创建新任务', async () => {
    const tracker = new TaskTracker('/tmp/octopi-test-apply-' + Date.now());

    await applyDecision(tracker, 'session-1', {
      injectTaskContext: false,
      taskContext: '',
      interruptedTasks: [],
      newTask: '新任务描述',
      completesTask: null,
      resumeTask: null,
      reason: '新任务',
    });

    const tasks = tracker.getActiveTasks('session-1');
    expect(tasks.length).toBe(1);
    expect(tasks[0].description).toBe('新任务描述');
  });
});

// ── TaskStage 集成测试 ──

describe('TaskStage', () => {
  it('没有 sessionId 时跳过', async () => {
    const provider = createMockProvider();
    const stage = new TaskStage({ provider, model: 'mock' });
    const ctx = createStageContext([{ role: 'user', content: '你好', timestamp: Date.now() }]);

    const result = await stage.process(ctx);

    expect(result.systemPrompt).toBe('You are a helpful assistant.');
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('有活跃任务时注入上下文', async () => {
    const provider = createMockProvider({
      content: JSON.stringify({
        injectTaskContext: true,
        taskContext: '你有一个进行中的任务：分析代码质量。用户回来了，向用户说明进展并询问是否继续。',
        interruptedTasks: [],
        newTask: null,
        completesTask: null,
        resumeTask: null,
        reason: '用户回来了',
      }),
    });

    const stage = new TaskStage({ provider, model: 'mock', dataDir: '/tmp/octopi-test-stage-' + Date.now() });

    // 先创建一个任务
    const tracker = (stage as any).tracker as TaskTracker;
    await tracker.create('session-1', '分析代码质量');

    const ctx = createStageContext(
      [{ role: 'user', content: '那个代码分析怎么样了？', timestamp: Date.now() }],
      'session-1',
    );

    const result = await stage.process(ctx);

    expect(result.systemPrompt).toContain('task_context');
    expect(result.systemPrompt).toContain('分析代码质量');
  });

  it('没有活跃任务时不注入', async () => {
    const provider = createMockProvider({
      content: JSON.stringify({
        injectTaskContext: false,
        taskContext: '',
        interruptedTasks: [],
        newTask: null,
        completesTask: null,
        resumeTask: null,
        reason: '无任务',
      }),
    });

    const stage = new TaskStage({ provider, model: 'mock', dataDir: '/tmp/octopi-test-stage-' + Date.now() });

    const ctx = createStageContext(
      [{ role: 'user', content: '你好', timestamp: Date.now() }],
      'session-1',
    );

    const result = await stage.process(ctx);

    expect(result.systemPrompt).toBe('You are a helpful assistant.');
  });
});
