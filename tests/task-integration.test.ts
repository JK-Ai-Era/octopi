/**
 * TaskManagerPlugin 集成测试
 *
 * 验证 TaskManager plugin 在新 plugin 系统中的完整适配：
 * - 通过 PluginManager 注册和发现
 * - Hook priority 排序
 * - runHook 拦截语义
 * - before_iteration → after_iteration 完整流水线
 * - Gateway 生命周期
 * - 多 plugin 共存
 * - 禁用状态
 * - 错误恢复
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createTaskManagerPlugin } from '../src/tasks/plugin.js';
import { PluginManager } from '../src/plugins/manager.js';
import { PluginApi } from '../src/plugins/api.js';
import { definePluginEntry } from '../src/plugins/entry.js';
import type { TaskDecision, TaskManagerConfig } from '../src/tasks/types.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/core/types.js';
import type { LoadedPlugin } from '../src/plugins/loader.js';
import { rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

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

const TEST_SESSION = 'integration-test-session';

/**
 * 创建一个注册了 TaskManagerPlugin 的 PluginManager。
 * Plugin 通过手动注入 LoadedPlugin 的方式加载（不走文件系统 discovery）。
 */
function createPluginManagerWithTaskPlugin(
  provider: LLMProvider,
  config: TaskManagerConfig,
  extraPlugins: Array<{ id: string; register: (api: PluginApi) => void }> = [],
): PluginManager {
  const pm = new PluginManager({ loadPaths: [] });

  // 手动注入 TaskManager plugin
  const taskPluginDef = createTaskManagerPlugin(provider, config);
  const taskApi = new PluginApi({
    id: taskPluginDef.id,
    name: taskPluginDef.name,
    source: 'test:task-manager',
    pluginConfig: {},
  });
  taskPluginDef.register(taskApi);

  const taskLoaded: LoadedPlugin = {
    id: taskPluginDef.id,
    manifest: {
      id: taskPluginDef.id,
      configSchema: {},
    },
    definition: taskPluginDef,
    api: taskApi,
    registered: true,
    source: 'test:task-manager',
  };

  // 手动注入额外 plugins
  const extraLoaded: LoadedPlugin[] = extraPlugins.map((p) => {
    const api = new PluginApi({
      id: p.id,
      name: p.id,
      source: `test:${p.id}`,
      pluginConfig: {},
    });
    p.register(api);
    return {
      id: p.id,
      manifest: { id: p.id, configSchema: {} },
      definition: definePluginEntry({ id: p.id, name: p.id, register: p.register }),
      api,
      registered: true,
      source: `test:${p.id}`,
    };
  });

  // 直接注入 loader（通过内部访问）
  // PluginLoader 内部使用 Map<string, LoadedPlugin> 名为 plugins
  const pluginMap = new Map<string, LoadedPlugin>();
  pluginMap.set(taskLoaded.id, taskLoaded);
  for (const p of extraLoaded) {
    pluginMap.set(p.id, p);
  }
  (pm as any).loader.plugins = pluginMap;

  return pm;
}

// ─────────────────────────────────────────────
// Integration Tests
// ─────────────────────────────────────────────

describe('TaskManagerPlugin Integration', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(tmpdir(), `octopi-integration-${Date.now()}`);
  });

  afterEach(() => {
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // ================================================================
  // 1. PluginManager 发现和注册
  // ================================================================

  describe('PluginManager 注册', () => {
    test('TaskManagerPlugin 通过 PluginManager 正确注册', () => {
      const provider = createMockProvider([makeDecision()]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config);

      expect(pm.getRegisteredIds()).toContain('task-manager');
      expect(pm.getPlugin('task-manager')).toBeDefined();
      expect(pm.getPlugin('task-manager')!.registered).toBe(true);
    });

    test('disabled plugin 不注册任何 hooks', () => {
      const provider = createMockProvider([makeDecision()]);
      const config: TaskManagerConfig = {
        enabled: false,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config);
      const plugin = pm.getPlugin('task-manager')!;

      // register() 被调用了（因为 plugin 已加载），但没有注册 hooks
      expect(plugin.api._hooks.size).toBe(0);
    });
  });

  // ================================================================
  // 2. Hook Priority 排序
  // ================================================================

  describe('Hook Priority', () => {
    test('TaskManager 的 hooks 以 priority 10 注册，高于默认 0', async () => {
      const provider = createMockProvider([makeDecision()]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      // 添加一个 priority 0 的观察 plugin
      const pm = createPluginManagerWithTaskPlugin(provider, config, [
        {
          id: 'observer-plugin',
          register(api) {
            api.on('before_iteration', async () => {
              return null; // 不拦截
            }, { priority: 0 });
          },
        },
      ]);

      // 通过 runHook 验证执行顺序：priority 10 的先执行
      const callOrder: string[] = [];

      // 替换 handler 来追踪顺序
      const taskPlugin = pm.getPlugin('task-manager')!;
      const observerPlugin = pm.getPlugin('observer-plugin')!;

      const taskEntries = taskPlugin.api._hooks.get('before_iteration')!;
      const origTaskHandler = taskEntries[0].handler;
      taskEntries[0].handler = async (event: any) => {
        callOrder.push('task-manager');
        return origTaskHandler(event);
      };

      const obsEntries = observerPlugin.api._hooks.get('before_iteration')!;
      const origObsHandler = obsEntries[0].handler;
      obsEntries[0].handler = async (event: any) => {
        callOrder.push('observer');
        return origObsHandler(event);
      };

      await pm.runHook('before_iteration', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '测试', timestamp: Date.now() }],
      }, null);

      // TaskManager (priority 10) 应该在 observer (priority 0) 之前执行
      expect(callOrder[0]).toBe('task-manager');
      expect(callOrder[1]).toBe('observer');
    });
  });

  // ================================================================
  // 3. before_iteration → after_iteration 完整流水线
  // ================================================================

  describe('完整流水线', () => {
    test('新任务 → 上下文注入', async () => {
      const decision = makeDecision({
        newTask: '分析代码质量',
        injectTaskContext: true,
        taskContext: '<task>你有一个活跃任务：分析代码质量</task>',
        reason: '用户描述了新工作',
      });

      const provider = createMockProvider([decision]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config);

      // before_iteration 返回 prependContext（一步到位）
      const result = await pm.runHook('before_iteration', {
        sessionId: TEST_SESSION,
        iteration: 0,
        messages: [{ role: 'user', content: '帮我分析代码质量', timestamp: Date.now() }],
        model: 'test-model',
        ctx: { sessionId: TEST_SESSION, turnId: 'turn-0', turnIndex: 0 },
      }, null);

      expect(result).not.toBeNull();
      expect(result!.prependContext).toContain('分析代码质量');
    });

    test('中断任务 → 注入被中断的任务上下文', async () => {
      const provider = createMockProvider([
        // 第一次：创建任务
        makeDecision({
          newTask: '重构认证模块',
          reason: '新任务',
        }),
        // 第二次：用户发了无关消息，中断
        makeDecision({
          interruptedTasks: ['__will_be_resolved__'],
          injectTaskContext: true,
          taskContext: '<task>你有一个被中断的任务：重构认证模块</task>',
          reason: '用户发了无关消息',
        }),
      ]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config);

      // Step 1: 创建任务（无 taskContext，返回 null）
      const createResult = await pm.runHook('before_iteration', {
        sessionId: TEST_SESSION,
        iteration: 0,
        messages: [{ role: 'user', content: '重构认证模块', timestamp: Date.now() }],
        model: 'test-model',
        ctx: { sessionId: TEST_SESSION, turnId: 'turn-0', turnIndex: 0 },
      }, null);
      expect(createResult).toBeNull();

      // Step 2: 用户发无关消息，TaskManager 决定中断，返回 taskContext
      const interruptResult = await pm.runHook('before_iteration', {
        sessionId: TEST_SESSION,
        iteration: 1,
        messages: [
          { role: 'user', content: '重构认证模块', timestamp: Date.now() },
          { role: 'assistant', content: '好的，开始分析...', timestamp: Date.now() },
          { role: 'user', content: '帮我查天气', timestamp: Date.now() },
        ],
        model: 'test-model',
        ctx: { sessionId: TEST_SESSION, turnId: 'turn-1', turnIndex: 1 },
      }, null);

      expect(interruptResult).not.toBeNull();
      expect(interruptResult!.prependContext).toContain('被中断');
    });

    test('无活跃任务 → 不注入上下文', async () => {
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

      const pm = createPluginManagerWithTaskPlugin(provider, config);

      const result = await pm.runHook('before_iteration', {
        sessionId: TEST_SESSION,
        iteration: 0,
        messages: [{ role: 'user', content: '你好', timestamp: Date.now() }],
        model: 'test-model',
        ctx: { sessionId: TEST_SESSION, turnId: 'turn-0', turnIndex: 0 },
      }, null);

      expect(result).toBeNull();
    });

    test('恢复被中断的任务', async () => {
      const provider = createMockProvider([
        // 创建任务
        makeDecision({ newTask: '编写单元测试', reason: '新任务' }),
        // 中断
        makeDecision({
          interruptedTasks: ['__task_id__'],
          reason: '用户发了无关消息',
        }),
        // 恢复
        makeDecision({
          resumeTask: '__task_id__',
          injectTaskContext: true,
          taskContext: '<task>恢复任务：编写单元测试</task>',
          reason: '用户要求继续',
        }),
      ]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config);

      // 创建
      await pm.runHook('before_iteration', {
        sessionId: TEST_SESSION,
        iteration: 0,
        messages: [{ role: 'user', content: '编写单元测试', timestamp: Date.now() }],
        model: 'test-model',
        ctx: { sessionId: TEST_SESSION, turnId: 'turn-0', turnIndex: 0 },
      }, null);

      // 中断
      await pm.runHook('before_iteration', {
        sessionId: TEST_SESSION,
        iteration: 1,
        messages: [
          { role: 'user', content: '帮我查天气', timestamp: Date.now() },
        ],
        model: 'test-model',
        ctx: { sessionId: TEST_SESSION, turnId: 'turn-1', turnIndex: 1 },
      }, null);

      // 恢复
      const result = await pm.runHook('before_iteration', {
        sessionId: TEST_SESSION,
        iteration: 2,
        messages: [
          { role: 'user', content: '继续之前的任务', timestamp: Date.now() },
        ],
        model: 'test-model',
        ctx: { sessionId: TEST_SESSION, turnId: 'turn-2', turnIndex: 2 },
      }, null);

      expect(result).not.toBeNull();
      expect(result!.prependContext).toContain('恢复');
    });
  });

  // ================================================================
  // 4. Gateway 生命周期
  // ================================================================

  describe('Gateway 生命周期', () => {
    test('gateway_start hook 触发', async () => {
      const provider = createMockProvider([makeDecision()]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config);

      // 不应抛出异常
      await pm.onGatewayStart();
    });
  });

  // ================================================================
  // 5. 多 Plugin 共存
  // ================================================================

  describe('多 Plugin 共存', () => {
    test('TaskManager 与其他 plugin 的 hooks 互不干扰', async () => {
      const provider = createMockProvider([
        makeDecision({
          newTask: '分析代码',
          reason: '新任务',
        }),
      ]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const otherPluginHookCalls: string[] = [];

      const pm = createPluginManagerWithTaskPlugin(provider, config, [
        {
          id: 'tool-logger',
          register(api) {
            // 观察语义 hook — 记录 tool 调用
            api.on('after_tool_call', async (event: any) => {
              otherPluginHookCalls.push(`tool:${event.call?.toolName ?? 'unknown'}`);
            });

            // 也注册一个 before_iteration，但不拦截
            api.on('before_iteration', async () => {
              otherPluginHookCalls.push('before_iteration:logger');
              return null;
            }, { priority: 5 });
          },
        },
        {
          id: 'message-filter',
          register(api) {
            api.on('message_received', async (event: any) => {
              otherPluginHookCalls.push(`msg:${event.message?.content ?? ''}`);
            });
          },
        },
      ]);

      // 运行 before_iteration — 两个 plugin 都应执行
      await pm.runHook('before_iteration', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '分析代码', timestamp: Date.now() }],
      }, null);

      // tool-logger 的 before_iteration 应该被调用
      expect(otherPluginHookCalls).toContain('before_iteration:logger');

      // 运行 after_tool_call — 只有 tool-logger 应响应
      await pm.runAllHooks('after_tool_call', {
        call: { id: '1', toolName: 'web_search', params: {} },
        result: { callId: '1', content: 'ok', isError: false },
      });

      expect(otherPluginHookCalls).toContain('tool:web_search');

      // 运行 message_received — 只有 message-filter 应响应
      await pm.runAllHooks('message_received', {
        message: { content: 'hello', role: 'user', timestamp: Date.now() },
      });

      expect(otherPluginHookCalls).toContain('msg:hello');
    });

    test('多个 plugin 注册同一 hook 时都执行（观察语义）', async () => {
      const executionLog: string[] = [];

      const provider = createMockProvider([makeDecision()]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config, [
        {
          id: 'logger-a',
          register(api) {
            api.on('gateway_start', async () => {
              executionLog.push('logger-a');
            });
          },
        },
        {
          id: 'logger-b',
          register(api) {
            api.on('gateway_start', async () => {
              executionLog.push('logger-b');
            });
          },
        },
      ]);

      await pm.onGatewayStart();

      // 两个 logger 都应执行
      expect(executionLog).toContain('logger-a');
      expect(executionLog).toContain('logger-b');
      // TaskManager 的 gateway_start 也应执行（但没有日志输出到 executionLog）
    });
  });

  // ================================================================
  // 6. 错误恢复
  // ================================================================

  describe('错误恢复', () => {
    test('LLM 调用失败不中断 before_iteration 链', async () => {
      const failProvider: LLMProvider = {
        name: 'fail-provider',
        models: ['fail-model'],
        supportsModel: () => true,
        complete: async () => {
          throw new Error('API timeout');
        },
      };

      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'fail-provider',
        model: 'fail-model',
        dataDir,
      };

      const otherExecuted = { value: false };

      const pm = createPluginManagerWithTaskPlugin(failProvider, config, [
        {
          id: 'fallback-plugin',
          register(api) {
            api.on('before_iteration', async () => {
              otherExecuted.value = true;
              return null;
            }, { priority: 0 });
          },
        },
      ]);

      // TaskManager 的 LLM 会失败，但不应抛出异常
      const result = await pm.runHook('before_iteration', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '测试', timestamp: Date.now() }],
      }, null);

      // 结果应为默认值（null）
      expect(result).toBeNull();

      // 后续 plugin 应该仍然执行
      expect(otherExecuted.value).toBe(true);
    });

    test('before_iteration handler 超时不阻塞后续 handlers', async () => {
      const provider = createMockProvider([makeDecision()]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const afterExecuted = { value: false };

      const pm = createPluginManagerWithTaskPlugin(provider, config, [
        {
          id: 'timeout-plugin',
          register(api) {
            api.on('before_iteration', async () => {
              // 模拟超长执行
              await new Promise((r) => setTimeout(r, 100));
              return null;
            }, { priority: 100, timeoutMs: 10 }); // 10ms 超时
          },
        },
        {
          id: 'after-plugin',
          register(api) {
            api.on('before_iteration', async () => {
              afterExecuted.value = true;
              return null;
            }, { priority: 0 });
          },
        },
      ]);

      const result = await pm.runHook('before_iteration', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '测试', timestamp: Date.now() }],
      }, null);

      expect(result).toBeNull();
      expect(afterExecuted.value).toBe(true);
    });
  });

  // ================================================================
  // 7. 拦截语义验证
  // ================================================================

  describe('拦截语义', () => {
    test('其他 plugin 返回非 null 时中断 before_iteration 链', async () => {
      const provider = createMockProvider([makeDecision()]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const taskManagerExecuted = { value: false };

      const pm = createPluginManagerWithTaskPlugin(provider, config, [
        {
          id: 'interceptor',
          register(api) {
            // priority 20 > TaskManager 的 10，先执行
            api.on('before_iteration', async () => {
              return { role: 'assistant', content: '拦截！', timestamp: Date.now() };
            }, { priority: 20 });
          },
        },
      ]);

      // 替换 TaskManager handler 来追踪是否执行
      const taskPlugin = pm.getPlugin('task-manager')!;
      const entries = taskPlugin.api._hooks.get('before_iteration')!;
      const origHandler = entries[0].handler;
      entries[0].handler = async (event: any) => {
        taskManagerExecuted.value = true;
        return origHandler(event);
      };

      const result = await pm.runHook('before_iteration', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '测试', timestamp: Date.now() }],
      }, null);

      // 拦截器返回了 Message，应该成为最终结果
      expect(result).not.toBeNull();
      expect(result!.content).toBe('拦截！');

      // TaskManager 的 handler 也执行了（runHook 只在 block/cancel/outcome 时中断）
      // 但它的返回值是 null，不会覆盖拦截器的结果
      expect(taskManagerExecuted.value).toBe(true);
      // 最终结果仍然是拦截器的 Message
      expect(result!.content).toBe('拦截！');
    });

    test('runHook 的 terminal 检测（block: true）', async () => {
      const provider = createMockProvider([makeDecision()]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config, [
        {
          id: 'blocker',
          register(api) {
            api.on('before_tool_call', async () => {
              return { block: true, blockReason: '安全策略阻止' };
            }, { priority: 100 });
          },
        },
        {
          id: 'logger',
          register(api) {
            api.on('before_tool_call', async () => {
              return null;
            }, { priority: 0 });
          },
        },
      ]);

      const result = await pm.runHook('before_tool_call', {
        toolName: 'shell',
        params: { command: 'rm -rf /' },
        call: { id: '1', toolName: 'shell', params: {} },
        ctx: { sessionId: TEST_SESSION, agentId: 'test' },
      }, null);

      expect(result).not.toBeNull();
      expect(result!.block).toBe(true);
    });
  });

  // ================================================================
  // 8. Session 隔离
  // ================================================================

  describe('Session 隔离', () => {
    test('不同 session 的任务上下文互不干扰', async () => {
      const sessionA = 'session-a';
      const sessionB = 'session-b';

      const provider = createMockProvider([
        // session A 的决策
        makeDecision({
          newTask: '任务 A',
          injectTaskContext: true,
          taskContext: '<task>session A 的任务</task>',
          reason: 'A 的任务',
        }),
        // session B 的决策
        makeDecision({
          newTask: '任务 B',
          injectTaskContext: true,
          taskContext: '<task>session B 的任务</task>',
          reason: 'B 的任务',
        }),
      ]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config);

      // Session A: before_iteration 返回 prependContext
      const ctxA = await pm.runHook('before_iteration', {
        sessionId: sessionA,
        iteration: 0,
        messages: [{ role: 'user', content: '任务 A', timestamp: Date.now() }],
        model: 'test-model',
        ctx: { sessionId: sessionA, turnId: 'turn-0', turnIndex: 0 },
      }, null);

      // Session B: before_iteration 返回 prependContext
      const ctxB = await pm.runHook('before_iteration', {
        sessionId: sessionB,
        iteration: 0,
        messages: [{ role: 'user', content: '任务 B', timestamp: Date.now() }],
        model: 'test-model',
        ctx: { sessionId: sessionB, turnId: 'turn-0', turnIndex: 0 },
      }, null);

      expect(ctxA!.prependContext).toContain('session A');
      expect(ctxB!.prependContext).toContain('session B');
    });

    // ─────────────────────────────────────────────
    // Phase 6: 并发 session 隔离压力测试
    // ─────────────────────────────────────────────

    test('3+ 个 session 同时操作时隔离正确', async () => {
      const sessions = ['concurrent-session-1', 'concurrent-session-2', 'concurrent-session-3'];
      const taskNames = ['并发任务 A', '并发任务 B', '并发任务 C'];
      const contexts = ['上下文 A', '上下文 B', '上下文 C'];

      // 为每个 session 准备一个独立的决策响应
      const provider = createMockProvider([
        makeDecision({ newTask: taskNames[0], taskContext: contexts[0], injectTaskContext: true, reason: 'session-1' }),
        makeDecision({ newTask: taskNames[1], taskContext: contexts[1], injectTaskContext: true, reason: 'session-2' }),
        makeDecision({ newTask: taskNames[2], taskContext: contexts[2], injectTaskContext: true, reason: 'session-3' }),
      ]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config);

      // 并发执行 3 个 session 的 before_iteration
      const results = await Promise.all(sessions.map(async (sessionId, index) => {
        return pm.runHook('before_iteration', {
          sessionId,
          iteration: 0,
          messages: [{ role: 'user', content: taskNames[index], timestamp: Date.now() }],
          model: 'test-model',
          ctx: { sessionId, turnId: `turn-${index}`, turnIndex: 0 },
        }, null);
      }));

      // 验证每个 session 收到正确的上下文
      expect(results[0]!.prependContext).toContain(contexts[0]);
      expect(results[1]!.prependContext).toContain(contexts[1]);
      expect(results[2]!.prependContext).toContain(contexts[2]);

      // 验证 session 间没有交叉污染
      expect(results[0]!.prependContext).not.toContain(contexts[1]);
      expect(results[1]!.prependContext).not.toContain(contexts[2]);
      expect(results[2]!.prependContext).not.toContain(contexts[0]);
    });

    test('并发操作后文件持久化正确', async () => {
      const sessions = ['persist-test-1', 'persist-test-2', 'persist-test-3'];
      const taskDescs = ['持久化任务 A', '持久化任务 B', '持久化任务 C'];

      const provider = createMockProvider([
        makeDecision({ newTask: taskDescs[0], reason: 'persist-1' }),
        makeDecision({ newTask: taskDescs[1], reason: 'persist-2' }),
        makeDecision({ newTask: taskDescs[2], reason: 'persist-3' }),
      ]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config);

      // 并发执行 3 个 session 的 before_iteration
      await Promise.all(sessions.map(async (sessionId, index) => {
        await pm.runHook('before_iteration', {
          sessionId,
          iteration: 0,
          messages: [{ role: 'user', content: taskDescs[index], timestamp: Date.now() }],
          model: 'test-model',
          ctx: { sessionId, turnId: `turn-${index}`, turnIndex: 0 },
        }, null);
      }));

      // 验证每个 session 的 JSONL 文件存在且内容正确
      for (const sessionId of sessions) {
        const filePath = join(dataDir, sessionId, 'tasks.jsonl');
        expect(existsSync(filePath)).toBe(true);

        const content = readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n');
        expect(lines.length).toBeGreaterThan(0);

        const createEvent = JSON.parse(lines[0]);
        expect(createEvent.action).toBe('create');
        expect(createEvent.sessionId).toBe(sessionId);
      }
    });
  });

  // ================================================================
  // 9. PluginManager API 集成
  // ================================================================

  describe('PluginManager API 集成', () => {
    test('getProviders 不返回 TaskManager（它不注册 provider）', () => {
      const provider = createMockProvider([makeDecision()]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config);

      expect(pm.getProviders()).toHaveLength(0);
    });

    test('getTools 不返回 TaskManager（它不注册 tool）', () => {
      const provider = createMockProvider([makeDecision()]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config);

      expect(pm.getTools()).toHaveLength(0);
    });

    test('TaskManager plugin 的 hooks 通过 PluginManager 正确收集', async () => {
      const provider = createMockProvider([makeDecision()]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config);

      // before_iteration 应该有 handler
      const replyResult = await pm.runHook('before_iteration', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '测试', timestamp: Date.now() }],
      }, null);

      // TaskManager 不拦截，返回 null
      expect(replyResult).toBeNull();

      // after_iteration 应该没有内容（因为没有触发决策）
      const promptResult = await pm.runHook('after_iteration', {
        sessionId: TEST_SESSION,
        messages: [],
      }, null);

      expect(promptResult).toBeNull();
    });
  });
});
