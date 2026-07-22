/**
 * Tests for distributed intelligence core data types
 */

import { describe, it, expect } from 'vitest';
import type {
  AgentInput,
  AgentOutput,
  InterceptOutput,
  ContextOutput,
  NotifyOutput,
  TriggerContext,
  AgentContext,
  TaskSummary,
} from '../../../src/harness/distributed/types.js';

describe('Distributed Types', () => {
  describe('TaskSummary', () => {
    it('should construct a valid TaskSummary', () => {
      const summary: TaskSummary = {
        agentId: 'test-agent',
        sessionId: 'test-session',
        recentTools: ['shell', 'read'],
        phase: 'agent_working',
        pendingAction: 'shell',
      };

      expect(summary.agentId).toBe('test-agent');
      expect(summary.sessionId).toBe('test-session');
      expect(summary.recentTools).toEqual(['shell', 'read']);
      expect(summary.phase).toBe('agent_working');
      expect(summary.pendingAction).toBe('shell');
    });

    it('should support user_request phase', () => {
      const summary: TaskSummary = {
        agentId: 'agent-1',
        sessionId: 'session-1',
        recentTools: [],
        phase: 'user_request',
      };

      expect(summary.phase).toBe('user_request');
      expect(summary.pendingAction).toBeUndefined();
    });
  });

  describe('AgentInput', () => {
    it('should construct an empty AgentInput', () => {
      const input: AgentInput = {};
      expect(input.pendingToolCall).toBeUndefined();
      expect(input.taskSummary).toBeUndefined();
    });

    it('should construct a full AgentInput', () => {
      const input: AgentInput = {
        pendingToolCall: { name: 'shell', arguments: { command: 'ls' } },
        taskSummary: {
          agentId: 'agent-1',
          sessionId: 'session-1',
          recentTools: ['shell'],
          phase: 'agent_working',
        },
        recentToolCalls: [
          { name: 'shell', arguments: { command: 'pwd' }, result: '/home' },
        ],
        workingDirectory: '/home/user',
        sessionMetadata: { agentId: 'agent-1', sessionId: 'session-1', turnCount: 5 },
        tokenCount: { used: 5000, limit: 100000 },
        conversationHistory: [],
        agentEvents: [],
      };

      expect(input.pendingToolCall?.name).toBe('shell');
      expect(input.taskSummary?.agentId).toBe('agent-1');
      expect(input.recentToolCalls).toHaveLength(1);
      expect(input.workingDirectory).toBe('/home/user');
      expect(input.sessionMetadata?.turnCount).toBe(5);
      expect(input.tokenCount?.used).toBe(5000);
    });
  });

  describe('AgentOutput', () => {
    it('should construct InterceptOutput with allow', () => {
      const output: InterceptOutput = {
        kind: 'intercept',
        decision: 'allow',
        reason: 'Safe command',
        confidence: 0.95,
      };

      expect(output.kind).toBe('intercept');
      expect(output.decision).toBe('allow');
      expect(output.confidence).toBe(0.95);
    });

    it('should construct InterceptOutput with degrade', () => {
      const output: InterceptOutput = {
        kind: 'intercept',
        decision: 'degrade',
        reason: 'Unsafe pattern detected',
        confidence: 0.8,
        alternative: {
          command: 'curl -o /tmp/file.sh ...',
          notice: 'Download first, then execute',
        },
      };

      expect(output.decision).toBe('degrade');
      expect(output.alternative?.command).toBe('curl -o /tmp/file.sh ...');
    });

    it('should construct InterceptOutput with block', () => {
      const output: InterceptOutput = {
        kind: 'intercept',
        decision: 'block',
        reason: 'Critical security violation',
        confidence: 0.99,
      };

      expect(output.decision).toBe('block');
      expect(output.alternative).toBeUndefined();
    });

    it('should construct ContextOutput', () => {
      const output: ContextOutput = {
        kind: 'context',
        messages: [
          { role: 'system', content: 'Compressed context' },
        ],
        compressed: true,
      };

      expect(output.kind).toBe('context');
      expect(output.messages).toHaveLength(1);
      expect(output.compressed).toBe(true);
    });

    it('should construct NotifyOutput', () => {
      const output: NotifyOutput = {
        kind: 'notify',
        content: 'Suspicious activity detected',
        level: 'warning',
      };

      expect(output.kind).toBe('notify');
      expect(output.level).toBe('warning');
    });

    it('should validate AgentOutput union type', () => {
      const outputs: AgentOutput[] = [
        { kind: 'intercept', decision: 'allow', reason: 'ok', confidence: 1 },
        { kind: 'context', messages: [] },
        { kind: 'notify', content: 'test', level: 'info' },
      ];

      expect(outputs).toHaveLength(3);
      expect(outputs[0].kind).toBe('intercept');
      expect(outputs[1].kind).toBe('context');
      expect(outputs[2].kind).toBe('notify');
    });
  });

  describe('TriggerContext', () => {
    it('should construct TriggerContext', () => {
      const ctx: TriggerContext = {
        eventData: { type: 'tool_call', name: 'shell' },
        metrics: { 'session.token_count': 50000 },
        recentToolCalls: [{ name: 'shell', success: true }],
        tokenCount: 50000,
        agentId: 'agent-1',
        sessionId: 'session-1',
      };

      expect(ctx.eventData).toBeDefined();
      expect(ctx.metrics?.['session.token_count']).toBe(50000);
      expect(ctx.recentToolCalls).toHaveLength(1);
    });
  });

  describe('AgentContext', () => {
    it('should construct AgentContext', () => {
      const mockEvents = {
        emit: () => {},
        on: () => ({ dispose: () => {} }),
        onAll: () => ({ dispose: () => {} }),
      };

      const ctx: AgentContext = {
        messages: [],
        runConfig: {
          systemPrompt: 'test',
          agentId: 'agent-1',
          sessionId: 'session-1',
        },
        pendingToolCall: { name: 'shell', arguments: { command: 'ls' } },
        events: mockEvents,
      };

      expect(ctx.messages).toEqual([]);
      expect(ctx.runConfig.agentId).toBe('agent-1');
      expect(ctx.pendingToolCall?.name).toBe('shell');
    });
  });
});
