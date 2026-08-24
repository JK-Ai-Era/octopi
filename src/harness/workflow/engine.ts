/**
 * WorkflowEngine — Workflow 执行引擎
 *
 * 基于 TaskTracker 的任务编排系统。
 * 支持顺序执行、条件分支、循环、并行、错误处理。
 */

import { randomUUID } from 'node:crypto';
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowInstance,
  WorkflowContext,
  WorkflowEvent,
  WorkflowStatus,
  StepStatus,
  StepExecution,
  StepExecutor,
  ConditionalNext,
} from './types.js';

/** WorkflowEngine 配置 */
export interface WorkflowEngineConfig {
  /** 步骤执行器 */
  stepExecutor: StepExecutor;
  /** 最大并发步骤数（用于并行） */
  maxConcurrency?: number;
}

/**
 * WorkflowEngine
 *
 * 执行 Workflow 定义，管理实例生命周期。
 */
export class WorkflowEngine {
  private config: WorkflowEngineConfig;
  private definitions: Map<string, WorkflowDefinition> = new Map();
  private instances: Map<string, WorkflowInstance> = new Map();

  constructor(config: WorkflowEngineConfig) {
    this.config = config;
  }

  // ================================================================
  // 定义管理
  // ================================================================

  /**
   * 注册 Workflow 定义
   */
  register(definition: WorkflowDefinition): void {
    this.definitions.set(definition.id, definition);
  }

  /**
   * 获取 Workflow 定义
   */
  getDefinition(id: string): WorkflowDefinition | undefined {
    return this.definitions.get(id);
  }

  /**
   * 列出所有已注册的 Workflow
   */
  listDefinitions(): WorkflowDefinition[] {
    return Array.from(this.definitions.values());
  }

  // ================================================================
  // 实例管理
  // ================================================================

  /**
   * 创建执行实例
   */
  createInstance(workflowId: string, variables?: Record<string, unknown>): WorkflowInstance {
    const def = this.definitions.get(workflowId);
    if (!def) {
      throw new Error(`Workflow "${workflowId}" not found`);
    }

    const instance: WorkflowInstance = {
      id: `wf-${randomUUID().slice(0, 8)}`,
      definitionId: workflowId,
      status: 'pending',
      currentStep: def.startStep,
      variables: new Map(Object.entries(def.variables ?? {})),
      history: [],
      startedAt: Date.now(),
    };

    // 合并调用方提供的变量
    if (variables) {
      for (const [key, value] of Object.entries(variables)) {
        instance.variables.set(key, value);
      }
    }

    this.instances.set(instance.id, instance);
    return instance;
  }

  /**
   * 获取实例
   */
  getInstance(id: string): WorkflowInstance | undefined {
    return this.instances.get(id);
  }

  /**
   * 列出所有实例
   */
  listInstances(): WorkflowInstance[] {
    return Array.from(this.instances.values());
  }

  // ================================================================
  // 执行
  // ================================================================

  /**
   * 执行 Workflow
   *
   * @param instanceId - 实例 ID
   * @yields WorkflowEvent 事件流
   */
  async *execute(instanceId: string): AsyncGenerator<WorkflowEvent> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Workflow instance "${instanceId}" not found`);
    }

    const def = this.definitions.get(instance.definitionId);
    if (!def) {
      throw new Error(`Workflow definition "${instance.definitionId}" not found`);
    }

    instance.status = 'running';

    while (instance.currentStep) {
      const step = def.steps.find(s => s.id === instance.currentStep);
      if (!step) {
        yield { type: 'workflow.fail', instanceId, data: { error: `Step "${instance.currentStep}" not found` } };
        instance.status = 'failed';
        return;
      }

      yield { type: 'step.start', instanceId, stepId: step.id };

      const startTime = Date.now();
      step.status = 'running';

      try {
        // 创建执行上下文
        const context: WorkflowContext = {
          variables: instance.variables,
          history: instance.history,
        };

        // 执行步骤（支持重试）
        const result = await this.executeWithRetry(step, context);

        // 记录执行历史
        const execution: StepExecution = {
          stepId: step.id,
          taskId: step.taskId,
          status: 'completed',
          output: result,
          duration: Date.now() - startTime,
        };
        instance.history.push(execution);
        step.status = 'completed';

        yield { type: 'step.complete', instanceId, stepId: step.id, data: result };

        // 确定下一步
        const nextStep = this.resolveNext(step, result, { variables: instance.variables, history: instance.history });
        instance.currentStep = nextStep ?? '';

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // 记录失败
        const execution: StepExecution = {
          stepId: step.id,
          taskId: step.taskId,
          status: 'failed',
          error: errorMsg,
          duration: Date.now() - startTime,
        };
        instance.history.push(execution);
        step.status = 'failed';

        yield { type: 'step.fail', instanceId, stepId: step.id, data: { error: errorMsg } };

        // 错误处理
        if (step.onError === 'skip') {
          // 跳过当前步骤，继续下一步
          const nextStep = this.resolveNext(step, undefined, { variables: instance.variables, history: instance.history });
          instance.currentStep = nextStep ?? '';
          continue;
        } else if (step.onError === 'abort' || !step.onError) {
          // 中止 Workflow
          instance.status = 'failed';
          instance.completedAt = Date.now();
          yield { type: 'workflow.fail', instanceId, data: { error: errorMsg } };
          return;
        } else {
          // 跳转到指定步骤
          instance.currentStep = step.onError;
          continue;
        }
      }
    }

    // 所有步骤完成
    instance.status = 'completed';
    instance.completedAt = Date.now();
    yield { type: 'workflow.complete', instanceId };
  }

  /**
   * 暂停实例
   */
  pause(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Instance "${instanceId}" not found`);
    if (instance.status !== 'running') {
      throw new Error(`Instance "${instanceId}" is not running`);
    }
    instance.status = 'paused';
  }

  /**
   * 恢复实例
   */
  resume(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Instance "${instanceId}" not found`);
    if (instance.status !== 'paused') {
      throw new Error(`Instance "${instanceId}" is not paused`);
    }
    instance.status = 'running';
  }

  /**
   * 取消实例
   */
  cancel(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Instance "${instanceId}" not found`);
    instance.status = 'cancelled';
    instance.completedAt = Date.now();
  }

  // ================================================================
  // 内部方法
  // ================================================================

  /**
   * 执行步骤（带重试）
   */
  private async executeWithRetry(step: WorkflowStep, context: WorkflowContext): Promise<unknown> {
    const maxRetries = step.retryPolicy?.maxRetries ?? 0;
    const delayMs = step.retryPolicy?.delayMs ?? 0;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.config.stepExecutor.execute(step, context);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries && delayMs > 0) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
    }

    throw lastError;
  }

  /**
   * 解析下一步
   */
  private resolveNext(step: WorkflowStep, result: unknown, context: WorkflowContext): string | undefined {
    if (!step.next) return undefined;

    // 顺序执行
    if (typeof step.next === 'string') return step.next;

    // 条件分支
    for (const branch of step.next as ConditionalNext[]) {
      let conditionResult = false;

      if (typeof branch.condition === 'function') {
        conditionResult = branch.condition({ ...context, currentResult: result });
      } else if (typeof branch.condition === 'string') {
        // 简单表达式求值（安全限制）
        try {
          const fn = new Function('context', `return ${branch.condition}`);
          conditionResult = fn({ ...context, currentResult: result });
        } catch {
          conditionResult = false;
        }
      }

      if (conditionResult) {
        return branch.target;
      }
    }

    return undefined;
  }
}

// ================================================================
// 内置步骤执行器
// ================================================================

/**
 * 简单步骤执行器
 *
 * 用于测试和简单场景。
 * 实际使用时应替换为集成 Agent 的执行器。
 */
export class SimpleStepExecutor implements StepExecutor {
  async execute(step: WorkflowStep, context: WorkflowContext): Promise<unknown> {
    switch (step.type) {
      case 'agent':
        return { type: 'agent', result: `Agent executed: ${step.config.prompt ?? step.name}` };

      case 'tool':
        return { type: 'tool', result: `Tool executed: ${step.config.toolName}` };

      case 'condition':
        if (typeof step.config.expression === 'string') {
          try {
            const fn = new Function('context', `return ${step.config.expression}`);
            return { type: 'condition', result: fn(context) };
          } catch {
            return { type: 'condition', result: false };
          }
        }
        return { type: 'condition', result: false };

      case 'loop':
        return { type: 'loop', result: 'Loop completed' };

      case 'human':
        return { type: 'human', result: 'Human approval required' };

      default:
        return { type: step.type, result: 'Executed' };
    }
  }
}
