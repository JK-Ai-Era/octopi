/**
 * AgentEvents 常量与 AgentEventMap 同步
 */

import { describe, it, expect } from 'vitest';
import { AgentEvents } from '../../src/harness/events/agent-event-map.js';

const MAP_KEYS = [
  'engine.start',
  'engine.end',
  'engine.error',
  'iteration.start',
  'turn.end',
  'tool.exec.start',
  'tool.exec.end',
  'budget.exceeded',
  'run_guard.stopped',
  'run_guard.recovered',
  'injection.detected',
  'sensitive_data.detected',
  'policy.violated',
  'session.lifecycle.updated',
  'session.ended',
  'persona.resolve.failed',
  'context.compact.start',
  'context.compact.end',
  'context.compact.error',
  'context.layers.assembled',
  'run.scope.ready',
  'run.scope.messages',
  'run.scope.llm',
  'run.guard.metrics',
  'security.blocked',
  'security.behavior_blocked',
  'task.created',
  'task.started',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.timeout',
  'task.retrying',
] as const;

describe('AgentEvents ↔ AgentEventMap', () => {
  it('每个常量值都是 Map 的 key', () => {
    for (const value of Object.values(AgentEvents)) {
      expect(MAP_KEYS).toContain(value);
    }
  });

  it('Map 的每个 key 都有对应常量', () => {
    const values = new Set(Object.values(AgentEvents));
    for (const key of MAP_KEYS) {
      expect(values).toContain(key);
    }
  });

  it('含 task.* 全套', () => {
    expect(AgentEvents.TASK_CREATED).toBe('task.created');
    expect(AgentEvents.TASK_RETRYING).toBe('task.retrying');
  });
});
