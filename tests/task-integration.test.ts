/**
 * TaskManagerPlugin 集成测试
 *
 * 验证 TaskManager plugin 在新 plugin 系统中的完整适配：
 * - 通过 PluginManager 注册和发现
 * - Hook priority 排序
 * - runHook 拦截语义
 * - before_agent_reply → before_prompt_build 完整流水线
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
import { rmSync, existsSync } from 'fs';
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
            api.on('before_agent_reply', async () => {
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

      const taskEntries = taskPlugin.api._hooks.get('before_agent_reply')!;
      const origTaskHandler = taskEntries[0].handler;
      taskEntries[0].handler = async (event: any) => {
        callOrder.push('task-manager');
        return origTaskHandler(event);
      };

      const obsEntries = observerPlugin.api._hooks.get('before_agent_reply')!;
      const origObsHandler = obsEntries[0].handler;
      obsEntries[0].handler = async (event: any) => {
        callOrder.push('observer');
        return origObsHandler(event);
      };

      await pm.runHook('before_agent_reply', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '测试', timestamp: Date.now() }],
      }, null);

      // TaskManager (priority 10) 应该在 observer (priority 0) 之前执行
      expect(callOrder[0]).toBe('task-manager');
      expect(callOrder[1]).toBe('observer');
    });
  });

  // ================================================================
  // 3. before_agent_reply → before_prompt_build 完整流水线
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

      // Step 1: before_agent_reply 做决策
      const replyResult = await pm.runHook('before_agent_reply', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '帮我分析代码质量', timestamp: Date.now() }],
      }, null);

      // 不拦截主 LLM
      expect(replyResult).toBeNull();

      // Step 2: before_prompt_build 注入上下文
      const promptResult = await pm.runHook('before_prompt_build', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '帮我分析代码质量', timestamp: Date.now() }],
      }, null);

      expect(promptResult).not.toBeNull();
      expect(promptResult!.prependContext).toContain('分析代码质量');
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

      // Step 1: 创建任务
      await pm.runHook('before_agent_reply', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '重构认证模块', timestamp: Date.now() }],
      }, null);

      // Step 2: 用户发无关消息，TaskManager 决定中断
      await pm.runHook('before_agent_reply', {
        sessionId: TEST_SESSION,
        messages: [
          { role: 'user', content: '重构认证模块', timestamp: Date.now() },
          { role: 'assistant', content: '好的，开始分析...', timestamp: Date.now() },
          { role: 'user', content: '帮我查天气', timestamp: Date.now() },
        ],
      }, null);

      // Step 3: before_prompt_build 注入中断任务上下文
      const promptResult = await pm.runHook('before_prompt_build', {
        sessionId: TEST_SESSION,
        messages: [],
      }, null);

      expect(promptResult).not.toBeNull();
      expect(promptResult!.prependContext).toContain('被中断');
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

      await pm.runHook('before_agent_reply', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '你好', timestamp: Date.now() }],
      }, null);

      const promptResult = await pm.runHook('before_prompt_build', {
        sessionId: TEST_SESSION,
        messages: [],
      }, null);

      expect(promptResult).toBeNull();
    });

    test('上下文注入只生效一次（用完即删）', async () => {
      const decision = makeDecision({
        injectTaskContext: true,
        taskContext: '<task>活跃任务</task>',
        reason: '有活跃任务',
      });

      const provider = createMockProvider([decision]);
      const config: TaskManagerConfig = {
        enabled: true,
        provider: 'mock-task-manager',
        model: 'mock-task-model',
        dataDir,
      };

      const pm = createPluginManagerWithTaskPlugin(provider, config);

      await pm.runHook('before_agent_reply', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '继续', timestamp: Date.now() }],
      }, null);

      // 第一次：有内容
      const first = await pm.runHook('before_prompt_build', {
        sessionId: TEST_SESSION,
        messages: [],
      }, null);
      expect(first).not.toBeNull();

      // 第二次：null（用完即删）
      const second = await pm.runHook('before_prompt_build', {
        sessionId: TEST_SESSION,
        messages: [],
      }, null);
      expect(second).toBeNull();
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
      await pm.runHook('before_agent_reply', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '编写单元测试', timestamp: Date.now() }],
      }, null);

      // 中断
      await pm.runHook('before_agent_reply', {
        sessionId: TEST_SESSION,
        messages: [
          { role: 'user', content: '帮我查天气', timestamp: Date.now() },
        ],
      }, null);

      // 恢复
      await pm.runHook('before_agent_reply', {
        sessionId: TEST_SESSION,
        messages: [
          { role: 'user', content: '继续之前的任务', timestamp: Date.now() },
        ],
      }, null);

      const promptResult = await pm.runHook('before_prompt_build', {
        sessionId: TEST_SESSION,
        messages: [],
      }, null);

      expect(promptResult).not.toBeNull();
      expect(promptResult!.prependContext).toContain('恢复');
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

            // 也注册一个 before_agent_reply，但不拦截
            api.on('before_agent_reply', async () => {
              otherPluginHookCalls.push('before_agent_reply:logger');
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

      // 运行 before_agent_reply — 两个 plugin 都应执行
      await pm.runHook('before_agent_reply', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '分析代码', timestamp: Date.now() }],
      }, null);

      // tool-logger 的 before_agent_reply 应该被调用
      expect(otherPluginHookCalls).toContain('before_agent_reply:logger');

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
    test('LLM 调用失败不中断 before_agent_reply 链', async () => {
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
            api.on('before_agent_reply', async () => {
              otherExecuted.value = true;
              return null;
            }, { priority: 0 });
          },
        },
      ]);

      // TaskManager 的 LLM 会失败，但不应抛出异常
      const result = await pm.runHook('before_agent_reply', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '测试', timestamp: Date.now() }],
      }, null);

      // 结果应为默认值（null）
      expect(result).toBeNull();

      // 后续 plugin 应该仍然执行
      expect(otherExecuted.value).toBe(true);
    });

    test('before_agent_reply handler 超时不阻塞后续 handlers', async () => {
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
            api.on('before_agent_reply', async () => {
              // 模拟超长执行
              await new Promise((r) => setTimeout(r, 100));
              return null;
            }, { priority: 100, timeoutMs: 10 }); // 10ms 超时
          },
        },
        {
          id: 'after-plugin',
          register(api) {
            api.on('before_agent_reply', async () => {
              afterExecuted.value = true;
              return null;
            }, { priority: 0 });
          },
        },
      ]);

      const result = await pm.runHook('before_agent_reply', {
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
    test('其他 plugin 返回非 null 时中断 before_agent_reply 链', async () => {
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
            api.on('before_agent_reply', async () => {
              return { role: 'assistant', content: '拦截！', timestamp: Date.now() };
            }, { priority: 20 });
          },
        },
      ]);

      // 替换 TaskManager handler 来追踪是否执行
      const taskPlugin = pm.getPlugin('task-manager')!;
      const entries = taskPlugin.api._hooks.get('before_agent_reply')!;
      const origHandler = entries[0].handler;
      entries[0].handler = async (event: any) => {
        taskManagerExecuted.value = true;
        return origHandler(event);
      };

      const result = await pm.runHook('before_agent_reply', {
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

      // Session A: 创建任务
      await pm.runHook('before_agent_reply', {
        sessionId: sessionA,
        messages: [{ role: 'user', content: '任务 A', timestamp: Date.now() }],
      }, null);

      // Session B: 创建任务
      await pm.runHook('before_agent_reply', {
        sessionId: sessionB,
        messages: [{ role: 'user', content: '任务 B', timestamp: Date.now() }],
      }, null);

      // Session A 的上下文
      const ctxA = await pm.runHook('before_prompt_build', {
        sessionId: sessionA,
        messages: [],
      }, null);

      // Session B 的上下文
      const ctxB = await pm.runHook('before_prompt_build', {
        sessionId: sessionB,
        messages: [],
      }, null);

      expect(ctxA!.prependContext).toContain('session A');
      expect(ctxB!.prependContext).toContain('session B');
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

      // before_agent_reply 应该有 handler
      const replyResult = await pm.runHook('before_agent_reply', {
        sessionId: TEST_SESSION,
        messages: [{ role: 'user', content: '测试', timestamp: Date.now() }],
      }, null);

      // TaskManager 不拦截，返回 null
      expect(replyResult).toBeNull();

      // before_prompt_build 应该没有内容（因为没有触发决策）
      const promptResult = await pm.runHook('before_prompt_build', {
        sessionId: TEST_SESSION,
        messages: [],
      }, null);

      expect(promptResult).toBeNull();
    });
  });
});
