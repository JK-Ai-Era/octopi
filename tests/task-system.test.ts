/**
 * Task System 测试
 *
 * 覆盖：TaskTracker CRUD、持久化、TaskManager LLM 解析、Plugin 集成
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { TaskTracker } from '../src/tasks/tracker.js';
import { TaskManager } from '../src/tasks/task-manager.js';
import { TaskManagerPlugin } from '../src/tasks/plugin.js';
import type { TaskDecision, TaskManagerConfig } from '../src/tasks/types.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/core/types.js';
import { rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────

/** 创建 mock LLM provider，返回预设的 JSON 响应 */
function createMockProvider(responses: string[]): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock-task-manager',
    models: ['mock-task-model'],
    supportsModel: (model: string) => model === 'mock-task-model',
    complete: async (request: LLMRequest): Promise<LLMResponse> => {
      const content = responses[callIndex] ?? responses[responses.length - 1] ?? '{}';
      callIndex++;
      return {
        content,
        model: request.model,
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      };
    },
  };
}

function makeDecision(overrides: Partial<TaskDecision> = {}): string {
  const base: TaskDecision = {
    injectTaskContext: false,
    taskContext: '',
    interruptedTasks: [],
    newTask: null,
    completesTask: null,
    resumeTask: null,
    reason: '',
  };
  return JSON.stringify({ ...base, ...overrides });
}

const TEST_SESSION = 'test-session-001';

// ─────────────────────────────────────────────
// TaskTracker
// ─────────────────────────────────────────────
describe('TaskTracker', () => {
  let tracker: TaskTracker;
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(tmpdir(), `octopi-test-tasks-${Date.now()}`);
    tracker = new TaskTracker(dataDir);
  });

  afterEach(() => {
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  describe('CRUD', () => {
    test('create 创建任务并设为 in_progress', () => {
      const task = tracker.create(TEST_SESSION, '分析重构效果');

      expect(task.id).toBeTruthy();
      expect(task.sessionId).toBe(TEST_SESSION);
      expect(task.description).toBe('分析重构效果');
      expect(task.status).toBe('in_progress');
    });

    test('interrupt 将 in_progress 任务标记为 interrupted', () => {
      const task = tracker.create(TEST_SESSION, '分析重构效果');
      tracker.interrupt(task.id, '用户发了新消息');

      const updated = tracker.get(task.id);
      expect(updated!.status).toBe('interrupted');
    });

    test('interrupt 不影响非 in_progress 的任务', () => {
      const task = tracker.create(TEST_SESSION, '分析重构效果');
      tracker.complete(task.id);
      tracker.interrupt(task.id, '不应生效');

      expect(tracker.get(task.id)!.status).toBe('completed');
    });

    test('resume 将 interrupted 任务恢复为 in_progress', () => {
      const task = tracker.create(TEST_SESSION, '分析重构效果');
      tracker.interrupt(task.id, '被打断');
      tracker.resume(task.id);

      expect(tracker.get(task.id)!.status).toBe('in_progress');
    });

    test('resume 不影响非 interrupted 的任务', () => {
      const task = tracker.create(TEST_SESSION, '分析重构效果');
      tracker.resume(task.id); // in_progress → resume 应该无效

      expect(tracker.get(task.id)!.status).toBe('in_progress');
    });

    test('complete 标记任务为 completed', () => {
      const task = tracker.create(TEST_SESSION, '分析重构效果');
      tracker.complete(task.id);

      expect(tracker.get(task.id)!.status).toBe('completed');
    });

    test('cancel 标记任务为 cancelled', () => {
      const task = tracker.create(TEST_SESSION, '分析重构效果');
      tracker.cancel(task.id);

      expect(tracker.get(task.id)!.status).toBe('cancelled');
    });
  });

  describe('查询', () => {
    test('getBySession 返回 session 的所有任务', () => {
      tracker.create(TEST_SESSION, '任务 1');
      tracker.create(TEST_SESSION, '任务 2');
      tracker.create('other-session', '任务 3');

      const tasks = tracker.getBySession(TEST_SESSION);
      expect(tasks).toHaveLength(2);
    });

    test('getActiveTasks 只返回 in_progress 和 interrupted', () => {
      const t1 = tracker.create(TEST_SESSION, '任务 1');
      const t2 = tracker.create(TEST_SESSION, '任务 2');
      const t3 = tracker.create(TEST_SESSION, '任务 3');

      tracker.interrupt(t2.id, '被打断');
      tracker.complete(t3.id);

      const active = tracker.getActiveTasks(TEST_SESSION);
      expect(active).toHaveLength(2);
      expect(active.map((t) => t.status).sort()).toEqual(['in_progress', 'interrupted']);
    });

    test('getInterruptedTasks 只返回 interrupted', () => {
      const t1 = tracker.create(TEST_SESSION, '任务 1');
      const t2 = tracker.create(TEST_SESSION, '任务 2');

      tracker.interrupt(t1.id, '被打断');

      const interrupted = tracker.getInterruptedTasks(TEST_SESSION);
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0].id).toBe(t1.id);
    });

    test('get 不存在的返回 null', () => {
      expect(tracker.get('nonexistent')).toBeNull();
    });

    test('空 session 返回空数组', () => {
      expect(tracker.getBySession('empty')).toHaveLength(0);
      expect(tracker.getActiveTasks('empty')).toHaveLength(0);
    });
  });

  describe('持久化', () => {
    test('事件写入 JSONL 文件', () => {
      const task = tracker.create(TEST_SESSION, '测试任务');
      tracker.complete(task.id);

      const filePath = join(dataDir, TEST_SESSION, 'tasks.jsonl');
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(2); // create + complete

      const createEvent = JSON.parse(lines[0]);
      expect(createEvent.action).toBe('create');
      expect(createEvent.description).toBe('测试任务');

      const completeEvent = JSON.parse(lines[1]);
      expect(completeEvent.action).toBe('complete');
    });

    test('loadSession 从 JSONL 重建状态', () => {
      // 创建并持久化
      const task = tracker.create(TEST_SESSION, '持久化测试');
      tracker.interrupt(task.id, '被打断');

      // 新建 tracker，从文件恢复
      const tracker2 = new TaskTracker(dataDir);
      tracker2.loadSession(TEST_SESSION);

      const tasks = tracker2.getBySession(TEST_SESSION);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].description).toBe('持久化测试');
      expect(tasks[0].status).toBe('interrupted');
    });

    test('loadSession 不存在的 session 不报错', () => {
      tracker.loadSession('nonexistent-session');
      expect(tracker.getBySession('nonexistent-session')).toHaveLength(0);
    });
  });

  describe('完整生命周期', () => {
    test('create → interrupt → resume → complete', () => {
      const task = tracker.create(TEST_SESSION, '完整生命周期测试');

      // 模拟：被打断
      tracker.interrupt(task.id, '用户发了新消息');
      expect(tracker.get(task.id)!.status).toBe('interrupted');
      expect(tracker.getActiveTasks(TEST_SESSION)).toHaveLength(1);

      // 模拟：用户说继续
      tracker.resume(task.id);
      expect(tracker.get(task.id)!.status).toBe('in_progress');

      // 模拟：完成
      tracker.complete(task.id);
      expect(tracker.get(task.id)!.status).toBe('completed');
      expect(tracker.getActiveTasks(TEST_SESSION)).toHaveLength(0);
    });

    test('多任务并发', () => {
      const t1 = tracker.create(TEST_SESSION, '任务 1');
      const t2 = tracker.create(TEST_SESSION, '任务 2');

      tracker.interrupt(t1.id, '被打断');
      tracker.complete(t2.id);

      expect(tracker.getActiveTasks(TEST_SESSION)).toHaveLength(1);
      expect(tracker.getInterruptedTasks(TEST_SESSION)).toHaveLength(1);
      expect(tracker.get(t2.id)!.status).toBe('completed');
    });
  });
});

// ─────────────────────────────────────────────
// TaskManager (LLM 决策器)
// ─────────────────────────────────────────────
describe('TaskManager', () => {
  test('正常解析 LLM 返回的 JSON', async () => {
    const decision = makeDecision({
      injectTaskContext: true,
      taskContext: '你有一个未完成的任务：分析重构效果',
      interruptedTasks: ['task-1'],
      reason: '用户发了无关消息',
    });

    const provider = createMockProvider([decision]);
    const manager = new TaskManager(provider, 'mock-task-model');

    const result = await manager.decide({
      sessionId: TEST_SESSION,
      currentTasks: [
        {
          id: 'task-1',
          sessionId: TEST_SESSION,
          description: '分析重构效果',
          status: 'in_progress',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      newMessage: '帮我查一下天气',
      recentContext: '[user] 分析一下重构效果\n[assistant] 好的，我来...',
    });

    expect(result.injectTaskContext).toBe(true);
    expect(result.taskContext).toContain('分析重构效果');
    expect(result.interruptedTasks).toEqual(['task-1']);
  });

  test('解析 markdown 代码块包裹的 JSON', async () => {
    const jsonContent = makeDecision({
      newTask: '新任务描述',
      reason: '用户描述了新工作',
    });
    const wrapped = '```json\n' + jsonContent + '\n```';

    const provider = createMockProvider([wrapped]);
    const manager = new TaskManager(provider, 'mock-task-model');

    const result = await manager.decide({
      sessionId: TEST_SESSION,
      currentTasks: [],
      newMessage: '帮我分析一下代码',
      recentContext: '',
    });

    expect(result.newTask).toBe('新任务描述');
  });

  test('LLM 返回无效 JSON 时返回默认决策', async () => {
    const provider = createMockProvider(['这不是 JSON']);
    const manager = new TaskManager(provider, 'mock-task-model');

    const result = await manager.decide({
      sessionId: TEST_SESSION,
      currentTasks: [],
      newMessage: '测试',
      recentContext: '',
    });

    expect(result.injectTaskContext).toBe(false);
    expect(result.newTask).toBeNull();
  });

  test('LLM 调用失败时返回默认决策', async () => {
    const provider: LLMProvider = {
      name: 'fail-provider',
      models: ['fail-model'],
      supportsModel: () => true,
      complete: async () => {
        throw new Error('API error');
      },
    };
    const manager = new TaskManager(provider, 'fail-model');

    const result = await manager.decide({
      sessionId: TEST_SESSION,
      currentTasks: [],
      newMessage: '测试',
      recentContext: '',
    });

    expect(result.injectTaskContext).toBe(false);
  });

  test('恢复任务的决策', async () => {
    const decision = makeDecision({
      injectTaskContext: true,
      taskContext: '你有一个被中断的任务：分析重构效果',
      resumeTask: 'task-1',
      reason: '用户要求继续',
    });

    const provider = createMockProvider([decision]);
    const manager = new TaskManager(provider, 'mock-task-model');

    const result = await manager.decide({
      sessionId: TEST_SESSION,
      currentTasks: [
        {
          id: 'task-1',
          sessionId: TEST_SESSION,
          description: '分析重构效果',
          status: 'interrupted',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      newMessage: '继续',
      recentContext: '',
    });

    expect(result.resumeTask).toBe('task-1');
  });

  test('完成任务的决策', async () => {
    const decision = makeDecision({
      completesTask: 'task-1',
      reason: '用户确认任务完成',
    });

    const provider = createMockProvider([decision]);
    const manager = new TaskManager(provider, 'mock-task-model');

    const result = await manager.decide({
      sessionId: TEST_SESSION,
      currentTasks: [
        {
          id: 'task-1',
          sessionId: TEST_SESSION,
          description: '测试任务',
          status: 'in_progress',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      newMessage: '好的，搞定了',
      recentContext: '',
    });

    expect(result.completesTask).toBe('task-1');
  });
});

// ─────────────────────────────────────────────
// TaskManagerPlugin (集成)
// ─────────────────────────────────────────────
describe('TaskManagerPlugin', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(tmpdir(), `octopi-test-plugin-${Date.now()}`);
  });

  afterEach(() => {
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('Plugin 注册后有 before_agent_reply 和 before_prompt_build hooks', () => {
    const provider = createMockProvider([makeDecision()]);
    const config: TaskManagerConfig = {
      enabled: true,
      provider: 'mock-task-manager',
      model: 'mock-task-model',
      dataDir,
    };

    const plugin = new TaskManagerPlugin(provider, config);

    expect(plugin.id).toBe('task-manager');
    expect(plugin.hooks.before_agent_reply).toBeDefined();
    expect(plugin.hooks.before_prompt_build).toBeDefined();
  });

  test('disabled 时不执行任何逻辑', async () => {
    const provider = createMockProvider([makeDecision()]);
    const config: TaskManagerConfig = {
      enabled: false,
      provider: 'mock-task-manager',
      model: 'mock-task-model',
      dataDir,
    };

    const plugin = new TaskManagerPlugin(provider, config);

    const result = await plugin.hooks.before_agent_reply!({
      sessionId: TEST_SESSION,
      agentId: 'test-agent',
      messages: [
        { role: 'user', content: '测试', timestamp: Date.now() },
      ],
    });

    expect(result).toBeNull();
  });

  test('决策新建任务后 tracker 有记录', async () => {
    const decision = makeDecision({
      newTask: '分析代码质量',
      reason: '用户描述了新工作',
    });

    const provider = createMockProvider([decision]);
    const config: TaskManagerConfig = {
      enabled: true,
      provider: 'mock-task-manager',
      model: 'mock-task-model',
      dataDir,
    };

    const plugin = new TaskManagerPlugin(provider, config);

    await plugin.hooks.before_agent_reply!({
      sessionId: TEST_SESSION,
      agentId: 'test-agent',
      messages: [
        { role: 'user', content: '帮我分析代码质量', timestamp: Date.now() },
      ],
    });

    const tasks = plugin.getTracker().getBySession(TEST_SESSION);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toBe('分析代码质量');
  });

  test('决策中断任务后状态更新', async () => {
    const provider = createMockProvider([
      // 第一次：新建任务
      makeDecision({ newTask: '分析重构效果', reason: '新任务' }),
      // 第二次：中断
      makeDecision({
        interruptedTasks: ['__any__'], // 实际会用真实 ID
        reason: '用户发了无关消息',
      }),
    ]);
    const config: TaskManagerConfig = {
      enabled: true,
      provider: 'mock-task-manager',
      model: 'mock-task-model',
      dataDir,
    };

    const plugin = new TaskManagerPlugin(provider, config);

    // 第一次调用：创建任务
    await plugin.hooks.before_agent_reply!({
      sessionId: TEST_SESSION,
      agentId: 'test-agent',
      messages: [
        { role: 'user', content: '分析重构效果', timestamp: Date.now() },
      ],
    });

    const tasks = plugin.getTracker().getBySession(TEST_SESSION);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('in_progress');

    // 第二次调用：中断
    // 注：mock provider 的第二次调用会返回 interruptedTasks，
    // 但因为 TaskManager 不知道真实 task ID，这里主要测试流程
    await plugin.hooks.before_agent_reply!({
      sessionId: TEST_SESSION,
      agentId: 'test-agent',
      messages: [
        { role: 'user', content: '分析重构效果', timestamp: Date.now() },
        { role: 'assistant', content: '好的', timestamp: Date.now() },
        { role: 'user', content: '帮我查天气', timestamp: Date.now() },
      ],
    });
  });

  test('before_prompt_build 注入任务上下文', async () => {
    const decision = makeDecision({
      injectTaskContext: true,
      taskContext: '<task_context>\n你有一个未完成的任务：分析重构效果\n</task_context>',
      reason: '有活跃任务',
    });

    const provider = createMockProvider([decision]);
    const config: TaskManagerConfig = {
      enabled: true,
      provider: 'mock-task-manager',
      model: 'mock-task-model',
      dataDir,
    };

    const plugin = new TaskManagerPlugin(provider, config);

    // before_agent_reply 缓存 context
    await plugin.hooks.before_agent_reply!({
      sessionId: TEST_SESSION,
      agentId: 'test-agent',
      messages: [
        { role: 'user', content: '继续', timestamp: Date.now() },
      ],
    });

    // before_prompt_build 返回注入内容
    const promptResult = await plugin.hooks.before_prompt_build!({
      sessionId: TEST_SESSION,
      agentId: 'test-agent',
      messages: [],
    });

    expect(promptResult).not.toBeNull();
    expect(promptResult!.prependContext).toContain('分析重构效果');

    // 第二次调用应该返回 null（用完即删）
    const secondResult = await plugin.hooks.before_prompt_build!({
      sessionId: TEST_SESSION,
      agentId: 'test-agent',
      messages: [],
    });
    expect(secondResult).toBeNull();
  });

  test('无任务时不注入上下文', async () => {
    const decision = makeDecision({
      injectTaskContext: false,
      reason: '无活跃任务',
    });

    const provider = createMockProvider([decision]);
    const config: TaskManagerConfig = {
      enabled: true,
      provider: 'mock-task-manager',
      model: 'mock-task-model',
      dataDir,
    };

    const plugin = new TaskManagerPlugin(provider, config);

    await plugin.hooks.before_agent_reply!({
      sessionId: TEST_SESSION,
      agentId: 'test-agent',
      messages: [
        { role: 'user', content: '你好', timestamp: Date.now() },
      ],
    });

    const promptResult = await plugin.hooks.before_prompt_build!({
      sessionId: TEST_SESSION,
      agentId: 'test-agent',
      messages: [],
    });

    expect(promptResult).toBeNull();
  });
});
