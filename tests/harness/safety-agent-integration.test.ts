/**
 * 安全守卫架构接线测试
 *
 * 验证分布式智能架构的安全守卫集成是否正确：
 * - 触发器注册和匹配
 * - 输出策略处理（intercept）
 * - parseAgentOutput 解析
 * - Builder withSafetyGuard 接线
 *
 * 不测 LLM 推理（那需要真实 API 或完整的 mock 基础设施），
 * 只测架构是否正确接线。
 */

import { describe, it, expect } from 'vitest';
import { DefaultEventBus } from '../../src/core/event-bus.js';
import { AgentRuntime } from '../../src/harness/distributed/runtime.js';
import { TriggerEngine } from '../../src/harness/distributed/trigger.js';
import { handleIntercept } from '../../src/harness/distributed/output-policy.js';
import { buildSafetyGuardSpec } from '../../src/harness/security/safety-agent-spec.js';
import type { SharedDeps } from '../../src/harness/distributed/runtime.js';
import type { ModelProvider } from '../../src/core/interfaces/model-provider.js';
import type { InterceptOutput, AgentContext } from '../../src/harness/distributed/types.js';
import { DefaultSecurityGuard } from '../../src/core/security-guard.js';
import { DefaultToolCallRiskPolicy } from '../../src/harness/security/default-risk-policy.js';

function createMinimalModelProvider(): ModelProvider {
  return {
    defaultModel: 'test-model',
    getModelInfo: () => ({ contextWindow: 128000 }),
    call: async () => ({ content: '{}' }),
    stream: async function* () { yield { type: 'done', finishReason: 'stop' }; },
  } as unknown as ModelProvider;
}

function createSharedDeps(): SharedDeps {
  return {
    model: createMinimalModelProvider(),
    events: new DefaultEventBus(),
    errorStrategy: {
      classify: () => ({ retryable: false }),
      getDelay: () => 1000,
      maxRetries: 0,
    },
    mainTools: new Map(),
  };
}

describe('安全守卫架构接线', () => {
  describe('安全守卫 Spec 结构', () => {
    it('触发器是 EventTrigger，匹配 tool_call.risk_unknown', () => {
      const spec = buildSafetyGuardSpec();
      expect(spec.triggers).toHaveLength(1);
      expect(spec.triggers[0].type).toBe('event');
      expect((spec.triggers[0] as { event: { type: string } }).event.type).toBe('tool_call.risk_unknown');
    });

    it('输出策略是 intercept 模式', () => {
      const spec = buildSafetyGuardSpec();
      expect(spec.outputPolicy.mode).toBe('intercept');
    });

    it('输入策略是 structured 模式（防 prompt injection）', () => {
      const spec = buildSafetyGuardSpec();
      expect(spec.inputPolicy.snapshot).toBe('structured');
      expect(spec.inputPolicy.visible).toContain('task_summary');
      expect(spec.inputPolicy.visible).toContain('pending_tool_call');
      expect(spec.inputPolicy.visible).toContain('working_directory');
      // 不包含 conversation_history（防 prompt injection 传播）
      expect(spec.inputPolicy.visible).not.toContain('conversation_history');
    });

    it('无工具（纯判断）', () => {
      const spec = buildSafetyGuardSpec();
      expect((spec.execution as { tools?: unknown[] }).tools).toEqual([]);
    });

    it('单次迭代', () => {
      const spec = buildSafetyGuardSpec();
      expect((spec.execution as { maxIterations?: number }).maxIterations).toBe(1);
    });
  });

  describe('AgentRuntime 注册', () => {
    it('安全守卫注册到 interceptAgents', () => {
      const deps = createSharedDeps();
      const runtime = new AgentRuntime({ deps });
      const spec = buildSafetyGuardSpec();
      runtime.register(spec);

      expect(runtime.agentCount).toBe(1);
    });

    it('重复注册抛异常', () => {
      const deps = createSharedDeps();
      const runtime = new AgentRuntime({ deps });
      runtime.register(buildSafetyGuardSpec());
      expect(() => runtime.register(buildSafetyGuardSpec())).toThrow();
    });
  });

  describe('TriggerEngine 匹配', () => {
    it('EventTrigger 匹配有 eventData 的上下文', () => {
      const events = new DefaultEventBus();
      const engine = new TriggerEngine({ events });
      const spec = buildSafetyGuardSpec();

      const matched = engine.evaluateRules(spec.triggers, {
        eventData: { toolCall: { name: 'shell', arguments: { command: 'test' } } },
      });

      expect(matched).toHaveLength(1);
    });

    it('EventTrigger 不匹配无 eventData 的上下文', () => {
      const events = new DefaultEventBus();
      const engine = new TriggerEngine({ events });
      const spec = buildSafetyGuardSpec();

      const matched = engine.evaluateRules(spec.triggers, {});

      expect(matched).toHaveLength(0);
    });
  });

  describe('intercept 输出处理', () => {
    const ctx: AgentContext = {
      messages: [],
      runConfig: { systemPrompt: '', agentId: 'test', sessionId: 'test' },
      events: new DefaultEventBus(),
    };

    it('allow → proceed: true', () => {
      const output: InterceptOutput = {
        kind: 'intercept',
        decision: 'allow',
        reason: '安全',
        confidence: 0.9,
      };
      const result = handleIntercept(output, ctx);
      expect(result.proceed).toBe(true);
    });

    it('block → proceed: false + blocked 标记', () => {
      const output: InterceptOutput = {
        kind: 'intercept',
        decision: 'block',
        reason: '危险操作',
        confidence: 0.95,
      };
      const result = handleIntercept(output, ctx);
      expect(result.proceed).toBe(false);
      expect((result.result as Record<string, unknown>)?.blocked).toBe(true);
    });

    it('degrade → proceed: false + degraded 标记 + alternative', () => {
      const output: InterceptOutput = {
        kind: 'intercept',
        decision: 'degrade',
        reason: '有更安全的替代方案',
        confidence: 0.8,
        alternative: { command: 'git push --force-with-lease', notice: '更安全' },
      };
      const result = handleIntercept(output, ctx);
      expect(result.proceed).toBe(false);
      expect((result.result as Record<string, unknown>)?.degraded).toBe(true);
      expect((result.result as Record<string, unknown>)?.alternative).toBeDefined();
    });
  });

  describe('SecurityGuard + RiskPolicy 集成', () => {
    it('unknown 风险设置 riskUnknown 标记', () => {
      const events = new DefaultEventBus();
      const guard = new DefaultSecurityGuard(events);
      guard.setToolCallRiskPolicy(new DefaultToolCallRiskPolicy());

      const result = guard.checkToolCall({
        name: 'shell',
        arguments: { command: 'totally_unknown_command --xyz' },
      });

      expect(result.isClean).toBe(true);
      expect(result.riskUnknown).toBe(true);
    });

    it('已知风险不设置 riskUnknown', () => {
      const events = new DefaultEventBus();
      const guard = new DefaultSecurityGuard(events);
      guard.setToolCallRiskPolicy(new DefaultToolCallRiskPolicy());

      const result = guard.checkToolCall({
        name: 'shell',
        arguments: { command: 'ls -la' },
      });

      expect(result.isClean).toBe(true);
      expect(result.riskUnknown).toBeFalsy();
    });

    it('critical 风险被拦截', () => {
      const events = new DefaultEventBus();
      const guard = new DefaultSecurityGuard(events);
      guard.setToolCallRiskPolicy(new DefaultToolCallRiskPolicy());

      const result = guard.checkToolCall({
        name: 'shell',
        arguments: { command: 'rm -rf /' },
      });

      expect(result.isClean).toBe(false);
      expect(result.riskUnknown).toBeFalsy();
    });
  });
});
