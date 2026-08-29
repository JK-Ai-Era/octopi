import { describe, expect, it } from 'vitest';
import type { AgentInput, AgentOutput, InterceptOutput, ContextOutput, NotifyOutput, TriggerContext, AgentContext, TaskSummary } from '../../src/harness/distributed-agents/distributed/types.js';

describe('Distributed Intelligence — Core Types', () => {
  describe('AgentOutput variants', () => {
    it('InterceptOutput has correct structure', () => {
      const output: InterceptOutput = {
        kind: 'intercept',
        decision: 'degrade',
        reason: 'high risk',
        confidence: 0.9,
        alternative: { command: 'safe-cmd', notice: 'using safe alternative' },
      };
      expect(output.kind).toBe('intercept');
      expect(output.decision).toBe('degrade');
      expect(output.alternative).toBeDefined();
    });

    it('ContextOutput has correct structure', () => {
      const output: ContextOutput = {
        kind: 'context',
        messages: [{ role: 'system', content: 'compressed' }],
        compressed: true,
      };
      expect(output.kind).toBe('context');
      expect(output.compressed).toBe(true);
    });

    it('NotifyOutput has correct structure', () => {
      const output: NotifyOutput = {
        kind: 'notify',
        content: 'info message',
        level: 'info',
      };
      expect(output.kind).toBe('notify');
    });
  });

  describe('TaskSummary', () => {
    it('can be constructed with required fields', () => {
      const summary: TaskSummary = {
        agentId: 'agent-1',
        sessionId: 'session-1',
        recentTools: ['shell', 'file_read'],
        phase: 'agent_working',
      };
      expect(summary.agentId).toBe('agent-1');
      expect(summary.recentTools).toHaveLength(2);
    });

    it('supports optional pendingAction', () => {
      const summary: TaskSummary = {
        agentId: 'agent-1',
        sessionId: 'session-1',
        recentTools: [],
        phase: 'user_request',
        pendingAction: 'shell',
      };
      expect(summary.pendingAction).toBe('shell');
    });
  });

  describe('TriggerContext', () => {
    it('all fields are optional', () => {
      const ctx: TriggerContext = {};
      expect(ctx.eventData).toBeUndefined();
      expect(ctx.metrics).toBeUndefined();
    });
  });

  describe('AgentContext', () => {
    it('requires messages, runConfig, events', () => {
      const ctx: AgentContext = {
        messages: [],
        runConfig: { systemPrompt: 'test' },
        events: { emit: () => {}, on: () => ({ dispose: () => {} }), onAll: () => ({ dispose: () => {} }) } as any,
      };
      expect(ctx.messages).toEqual([]);
      expect(ctx.runConfig.systemPrompt).toBe('test');
    });
  });
});
