/**
 * DefaultAgentRegistry 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultAgentRegistry } from '../../src/harness/multi-agent/registry.js';
import { DefaultEventBus } from '../../src/core/event-bus.js';
import { AgentRegistryEvents } from '../../src/core/interfaces/agent-registry.js';
import type { AgentInfo, AgentQuery, AgentRelation } from '../../src/core/interfaces/agent-registry.js';

// ── 辅助函数 ──

function createAgent(overrides?: Partial<AgentInfo>): AgentInfo {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    capabilities: ['coding', 'analysis'],
    status: 'active',
    registeredAt: Date.now(),
    lastActiveAt: Date.now(),
    ...overrides,
  };
}

// ── 测试 ──

describe('DefaultAgentRegistry', () => {
  let registry: DefaultAgentRegistry;
  let events: DefaultEventBus;

  beforeEach(() => {
    events = new DefaultEventBus();
    registry = new DefaultAgentRegistry(events);
  });

  // ── 注册 / 注销 ──

  describe('register / unregister', () => {
    it('should register an agent', () => {
      const info = { id: 'a1', name: 'Agent 1', capabilities: ['coding'], status: 'active' as const };
      registry.register(info);

      const agent = registry.get('a1');
      expect(agent).toBeDefined();
      expect(agent!.id).toBe('a1');
      expect(agent!.name).toBe('Agent 1');
      expect(agent!.registeredAt).toBeGreaterThan(0);
      expect(agent!.lastActiveAt).toBeGreaterThan(0);
    });

    it('should emit AGENT_REGISTERED event', () => {
      const handler = vi.fn();
      events.on(AgentRegistryEvents.AGENT_REGISTERED, handler);

      registry.register({ id: 'a1', name: 'Agent 1', capabilities: ['coding'], status: 'active' });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].data.agentId).toBe('a1');
    });

    it('should unregister an agent', () => {
      registry.register({ id: 'a1', name: 'Agent 1', capabilities: ['coding'], status: 'active' });
      const result = registry.unregister('a1');

      expect(result).toBe(true);
      expect(registry.get('a1')).toBeUndefined();
    });

    it('should return false when unregistering non-existent agent', () => {
      expect(registry.unregister('nonexistent')).toBe(false);
    });

    it('should clean up relations when unregistering', () => {
      registry.register({ id: 'a1', name: 'Agent 1', capabilities: [], status: 'active' });
      registry.register({ id: 'a2', name: 'Agent 2', capabilities: [], status: 'active' });
      registry.addRelation({ from: 'a1', to: 'a2', type: 'peer' });

      registry.unregister('a1');

      const relations = registry.getRelations('a2');
      expect(relations).toHaveLength(0);
    });

    it('should emit AGENT_UNREGISTERED event', () => {
      const handler = vi.fn();
      events.on(AgentRegistryEvents.AGENT_UNREGISTERED, handler);

      registry.register({ id: 'a1', name: 'Agent 1', capabilities: [], status: 'active' });
      registry.unregister('a1');

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].data.agentId).toBe('a1');
    });
  });

  // ── 查询 ──

  describe('query', () => {
    beforeEach(() => {
      registry.register({ id: 'a1', name: 'Coder', capabilities: ['coding', 'testing'], status: 'active' });
      registry.register({ id: 'a2', name: 'Analyst', capabilities: ['analysis', 'reporting'], status: 'idle' });
      registry.register({ id: 'a3', name: 'DevOps', capabilities: ['coding', 'deployment'], status: 'busy' });
    });

    it('should list all agents', () => {
      expect(registry.list()).toHaveLength(3);
    });

    it('should query by capability', () => {
      const results = registry.query({ capabilities: ['coding'] });
      expect(results).toHaveLength(2);
      expect(results.map(a => a.id).sort()).toEqual(['a1', 'a3']);
    });

    it('should query by status', () => {
      const results = registry.query({ status: 'idle' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('a2');
    });

    it('should query by multiple capabilities (OR)', () => {
      const results = registry.query({ capabilities: ['analysis', 'deployment'] });
      expect(results).toHaveLength(2);
    });

    it('should query by metadata', () => {
      registry.register({
        id: 'a4', name: 'Special', capabilities: [], status: 'active',
        metadata: { team: 'backend', role: 'lead' },
      });

      const results = registry.query({ metadata: { team: 'backend' } });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('a4');
    });

    it('should return empty for non-matching query', () => {
      const results = registry.query({ capabilities: ['nonexistent'] });
      expect(results).toHaveLength(0);
    });
  });

  // ── findByCapability ──

  describe('findByCapability', () => {
    it('should find agents by capability', () => {
      registry.register({ id: 'a1', name: 'A', capabilities: ['coding'], status: 'active' });
      registry.register({ id: 'a2', name: 'B', capabilities: ['analysis'], status: 'active' });
      registry.register({ id: 'a3', name: 'C', capabilities: ['coding', 'analysis'], status: 'active' });

      const coders = registry.findByCapability('coding');
      expect(coders).toHaveLength(2);
      expect(coders.map(a => a.id).sort()).toEqual(['a1', 'a3']);
    });
  });

  // ── 状态管理 ──

  describe('status management', () => {
    it('should update agent status', () => {
      registry.register({ id: 'a1', name: 'A', capabilities: [], status: 'active' });
      registry.updateStatus('a1', 'busy');

      expect(registry.get('a1')!.status).toBe('busy');
    });

    it('should emit AGENT_STATUS_CHANGED event', () => {
      const handler = vi.fn();
      events.on(AgentRegistryEvents.AGENT_STATUS_CHANGED, handler);

      registry.register({ id: 'a1', name: 'A', capabilities: [], status: 'active' });
      registry.updateStatus('a1', 'busy');

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].data).toMatchObject({
        agentId: 'a1',
        oldStatus: 'active',
        newStatus: 'busy',
      });
    });

    it('should not emit event when status unchanged', () => {
      const handler = vi.fn();
      events.on(AgentRegistryEvents.AGENT_STATUS_CHANGED, handler);

      registry.register({ id: 'a1', name: 'A', capabilities: [], status: 'active' });
      registry.updateStatus('a1', 'active');

      expect(handler).not.toHaveBeenCalled();
    });

    it('should touch agent (update lastActiveAt)', () => {
      registry.register({ id: 'a1', name: 'A', capabilities: [], status: 'active' });
      const before = registry.get('a1')!.lastActiveAt;

      // 确保时间戳变化
      vi.useFakeTimers();
      vi.advanceTimersByTime(1000);
      registry.touch('a1');

      expect(registry.get('a1')!.lastActiveAt).toBeGreaterThan(before);
      vi.useRealTimers();
    });
  });

  // ── 关系管理 ──

  describe('relations', () => {
    beforeEach(() => {
      registry.register({ id: 'a1', name: 'A', capabilities: [], status: 'active' });
      registry.register({ id: 'a2', name: 'B', capabilities: [], status: 'active' });
      registry.register({ id: 'a3', name: 'C', capabilities: [], status: 'active' });
    });

    it('should add a relation', () => {
      registry.addRelation({ from: 'a1', to: 'a2', type: 'peer' });

      const relations = registry.getRelations('a1');
      expect(relations).toHaveLength(1);
      expect(relations[0]).toMatchObject({ from: 'a1', to: 'a2', type: 'peer' });
    });

    it('should emit RELATION_ADDED event', () => {
      const handler = vi.fn();
      events.on(AgentRegistryEvents.RELATION_ADDED, handler);

      registry.addRelation({ from: 'a1', to: 'a2', type: 'superior' });

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should not add duplicate relations', () => {
      registry.addRelation({ from: 'a1', to: 'a2', type: 'peer' });
      registry.addRelation({ from: 'a1', to: 'a2', type: 'peer' });

      expect(registry.getRelations('a1')).toHaveLength(1);
    });

    it('should remove a relation', () => {
      registry.addRelation({ from: 'a1', to: 'a2', type: 'peer' });
      registry.removeRelation('a1', 'a2', 'peer');

      expect(registry.getRelations('a1')).toHaveLength(0);
    });

    it('should remove all relations between two agents', () => {
      registry.addRelation({ from: 'a1', to: 'a2', type: 'peer' });
      registry.addRelation({ from: 'a1', to: 'a2', type: 'depends' });
      registry.removeRelation('a1', 'a2');

      expect(registry.getRelations('a1')).toHaveLength(0);
    });

    it('should get relations for both directions', () => {
      registry.addRelation({ from: 'a1', to: 'a2', type: 'peer' });
      registry.addRelation({ from: 'a3', to: 'a1', type: 'superior' });

      const relations = registry.getRelations('a1');
      expect(relations).toHaveLength(2);
    });

    it('should emit RELATION_REMOVED event', () => {
      const handler = vi.fn();
      events.on(AgentRegistryEvents.RELATION_REMOVED, handler);

      registry.addRelation({ from: 'a1', to: 'a2', type: 'peer' });
      registry.removeRelation('a1', 'a2', 'peer');

      expect(handler).toHaveBeenCalledOnce();
    });
  });
});
