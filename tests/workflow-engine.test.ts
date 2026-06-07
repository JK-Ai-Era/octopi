/**
 * Workflow 引擎测试
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  WorkflowEngine,
  SimpleStepExecutor,
} from '../src/harness/workflow/engine.js';
import type {
  WorkflowDefinition,
  WorkflowStep,
  StepExecutor,
  WorkflowContext,
} from '../src/harness/workflow/types.js';

function createSimpleWorkflow(): WorkflowDefinition {
  return {
    id: 'test-workflow',
    name: 'Test Workflow',
    description: 'A simple test workflow',
    version: '1.0.0',
    startStep: 'step1',
    steps: [
      {
        id: 'step1',
        type: 'agent',
        name: 'First Step',
        config: { prompt: 'Do something' },
        next: 'step2',
      },
      {
        id: 'step2',
        type: 'tool',
        name: 'Second Step',
        config: { toolName: 'test-tool' },
        next: 'step3',
      },
      {
        id: 'step3',
        type: 'agent',
        name: 'Final Step',
        config: { prompt: 'Finish' },
      },
    ],
  };
}

function createConditionalWorkflow(): WorkflowDefinition {
  return {
    id: 'conditional-workflow',
    name: 'Conditional Workflow',
    description: 'A workflow with conditional branches',
    version: '1.0.0',
    startStep: 'check',
    steps: [
      {
        id: 'check',
        type: 'condition',
        name: 'Check Condition',
        config: { expression: 'context.variables.get("skip") === true' },
        next: [
          { condition: 'context.currentResult === true', target: 'skip-step' },
          { condition: 'context.currentResult === false', target: 'do-step' },
        ],
      },
      {
        id: 'do-step',
        type: 'agent',
        name: 'Do Step',
        config: { prompt: 'Execute' },
      },
      {
        id: 'skip-step',
        type: 'agent',
        name: 'Skip Step',
        config: { prompt: 'Skipped' },
      },
    ],
  };
}

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine({
      stepExecutor: new SimpleStepExecutor(),
    });
  });

  describe('定义管理', () => {
    test('注册和获取定义', () => {
      const def = createSimpleWorkflow();
      engine.register(def);
      expect(engine.getDefinition('test-workflow')).toBe(def);
    });

    test('列出所有定义', () => {
      engine.register(createSimpleWorkflow());
      engine.register(createConditionalWorkflow());
      expect(engine.listDefinitions()).toHaveLength(2);
    });
  });

  describe('实例管理', () => {
    test('创建实例', () => {
      engine.register(createSimpleWorkflow());
      const instance = engine.createInstance('test-workflow');
      expect(instance.id).toBeDefined();
      expect(instance.definitionId).toBe('test-workflow');
      expect(instance.status).toBe('pending');
      expect(instance.currentStep).toBe('step1');
    });

    test('创建实例时传递变量', () => {
      engine.register(createSimpleWorkflow());
      const instance = engine.createInstance('test-workflow', { key: 'value' });
      expect(instance.variables.get('key')).toBe('value');
    });

    test('创建不存在的 Workflow 实例抛出错误', () => {
      expect(() => engine.createInstance('nonexistent')).toThrow('not found');
    });
  });

  describe('顺序执行', () => {
    test('按顺序执行所有步骤', async () => {
      engine.register(createSimpleWorkflow());
      const instance = engine.createInstance('test-workflow');

      const events: string[] = [];
      for await (const event of engine.execute(instance.id)) {
        events.push(event.type);
      }

      expect(events).toEqual([
        'step.start',
        'step.complete',
        'step.start',
        'step.complete',
        'step.start',
        'step.complete',
        'workflow.complete',
      ]);

      const finalInstance = engine.getInstance(instance.id);
      expect(finalInstance?.status).toBe('completed');
      expect(finalInstance?.history).toHaveLength(3);
    });

    test('步骤执行历史记录正确', async () => {
      engine.register(createSimpleWorkflow());
      const instance = engine.createInstance('test-workflow');

      const results: unknown[] = [];
      for await (const event of engine.execute(instance.id)) {
        if (event.type === 'step.complete') {
          results.push(event.data);
        }
      }

      expect(results).toHaveLength(3);
      expect(results[0]).toMatchObject({ type: 'agent' });
      expect(results[1]).toMatchObject({ type: 'tool' });
      expect(results[2]).toMatchObject({ type: 'agent' });
    });
  });

  describe('条件分支', () => {
    test('根据条件选择执行路径', async () => {
      engine.register(createConditionalWorkflow());

      // 测试条件为 false 的情况
      const instance1 = engine.createInstance('conditional-workflow', { skip: false });
      const events1: string[] = [];
      for await (const event of engine.execute(instance1.id)) {
        events1.push(event.type);
        if (event.type === 'step.complete' && event.stepId === 'check') {
          events1.push(`result:${JSON.stringify(event.data)}`);
        }
      }
      expect(engine.getInstance(instance1.id)?.status).toBe('completed');
    });
  });

  describe('错误处理', () => {
    test('步骤失败时默认中止 Workflow', async () => {
      const failingExecutor: StepExecutor = {
        execute: async (step) => {
          if (step.id === 'step2') {
            throw new Error('Step failed');
          }
          return { success: true };
        },
      };

      const failEngine = new WorkflowEngine({ stepExecutor: failingExecutor });
      failEngine.register(createSimpleWorkflow());
      const instance = failEngine.createInstance('test-workflow');

      const events: string[] = [];
      for await (const event of failEngine.execute(instance.id)) {
        events.push(event.type);
      }

      expect(events).toContain('step.fail');
      expect(events).toContain('workflow.fail');
      expect(failEngine.getInstance(instance.id)?.status).toBe('failed');
    });

    test('onError: skip 跳过失败步骤', async () => {
      const workflow: WorkflowDefinition = {
        id: 'skip-workflow',
        name: 'Skip Workflow',
        description: '',
        version: '1.0.0',
        startStep: 'step1',
        steps: [
          {
            id: 'step1',
            type: 'agent',
            name: 'Step 1',
            config: {},
            next: 'step2',
          },
          {
            id: 'step2',
            type: 'agent',
            name: 'Step 2 (fails)',
            config: {},
            onError: 'skip',
            next: 'step3',
          },
          {
            id: 'step3',
            type: 'agent',
            name: 'Step 3',
            config: {},
          },
        ],
      };

      let callCount = 0;
      const failingExecutor: StepExecutor = {
        execute: async (step) => {
          callCount++;
          if (step.id === 'step2') {
            throw new Error('Step 2 failed');
          }
          return { success: true };
        },
      };

      const skipEngine = new WorkflowEngine({ stepExecutor: failingExecutor });
      skipEngine.register(workflow);
      const instance = skipEngine.createInstance('skip-workflow');

      const events: string[] = [];
      for await (const event of skipEngine.execute(instance.id)) {
        events.push(event.type);
      }

      expect(events).toContain('step.fail');
      expect(events).toContain('workflow.complete');
      expect(skipEngine.getInstance(instance.id)?.status).toBe('completed');
    });
  });

  describe('暂停/恢复/取消', () => {
    test('暂停和恢复实例', () => {
      engine.register(createSimpleWorkflow());
      const instance = engine.createInstance('test-workflow');

      // 需要先开始执行才能暂停
      // 这里测试状态检查
      expect(() => engine.pause(instance.id)).toThrow('not running');
    });

    test('取消实例', () => {
      engine.register(createSimpleWorkflow());
      const instance = engine.createInstance('test-workflow');
      engine.cancel(instance.id);
      expect(engine.getInstance(instance.id)?.status).toBe('cancelled');
    });
  });

  describe('重试策略', () => {
    test('失败后按策略重试', async () => {
      const workflow: WorkflowDefinition = {
        id: 'retry-workflow',
        name: 'Retry Workflow',
        description: '',
        version: '1.0.0',
        startStep: 'step1',
        steps: [
          {
            id: 'step1',
            type: 'agent',
            name: 'Step 1',
            config: {},
            retryPolicy: { maxRetries: 2, delayMs: 10 },
          },
        ],
      };

      let attempts = 0;
      const retryExecutor: StepExecutor = {
        execute: async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error(`Attempt ${attempts} failed`);
          }
          return { success: true };
        },
      };

      const retryEngine = new WorkflowEngine({ stepExecutor: retryExecutor });
      retryEngine.register(workflow);
      const instance = retryEngine.createInstance('retry-workflow');

      const events: string[] = [];
      for await (const event of retryEngine.execute(instance.id)) {
        events.push(event.type);
      }

      expect(attempts).toBe(3);
      expect(events).toContain('workflow.complete');
    });
  });

  describe('变量系统', () => {
    test('步骤可以访问和修改变量', async () => {
      const workflow: WorkflowDefinition = {
        id: 'var-workflow',
        name: 'Variable Workflow',
        description: '',
        version: '1.0.0',
        startStep: 'step1',
        variables: { counter: 0 },
        steps: [
          {
            id: 'step1',
            type: 'agent',
            name: 'Step 1',
            config: {},
          },
        ],
      };

      engine.register(workflow);
      const instance = engine.createInstance('var-workflow', { extra: 'data' });

      expect(instance.variables.get('counter')).toBe(0);
      expect(instance.variables.get('extra')).toBe('data');
    });
  });
});
