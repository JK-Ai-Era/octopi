import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubsystemSessionManager, parseTTL } from '../../src/harness/autonomous-subsystem/session/manager.js';

describe('parseTTL', () => {
  it('parses minutes', () => { expect(parseTTL('30m')).toBe(30 * 60 * 1000); });
  it('parses hours', () => { expect(parseTTL('24h')).toBe(24 * 60 * 60 * 1000); });
  it('parses days', () => { expect(parseTTL('7d')).toBe(7 * 24 * 60 * 60 * 1000); });
  it('parses seconds', () => { expect(parseTTL('30s')).toBe(30 * 1000); });
  it('parses milliseconds', () => { expect(parseTTL('500ms')).toBe(500); });
  it('defaults to 30m for invalid format', () => { expect(parseTTL('invalid')).toBe(30 * 60 * 1000); });
});

describe('SubsystemSessionManager', () => {
  let manager: SubsystemSessionManager;

  beforeEach(() => {
    manager = new SubsystemSessionManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  describe('ephemeral mode', () => {
    it('creates new session each time', () => {
      const s1 = manager.getOrCreate('sub-1', { mode: 'ephemeral', scope: 'session' }, 'agent-a', 'sess-1');
      const s2 = manager.getOrCreate('sub-1', { mode: 'ephemeral', scope: 'session' }, 'agent-a', 'sess-1');

      expect(s1.key).toBe(s2.key);
      expect(s1).not.toBe(s2); // different instances
    });

    it('does not persist sessions', () => {
      manager.getOrCreate('sub-1', { mode: 'ephemeral', scope: 'session' }, 'agent-a', 'sess-1');
      expect(manager.activeSessionCount).toBe(0);
    });
  });

  describe('persistent mode', () => {
    it('reuses existing session', () => {
      const s1 = manager.getOrCreate('sub-1', { mode: 'persistent', scope: 'session' }, 'agent-a', 'sess-1');
      s1.messages.push({ role: 'user', content: 'hello', timestamp: Date.now() });

      const s2 = manager.getOrCreate('sub-1', { mode: 'persistent', scope: 'session' }, 'agent-a', 'sess-1');

      expect(s1).toBe(s2); // same instance
      expect(s2.messages).toHaveLength(1);
    });

    it('persists sessions', () => {
      manager.getOrCreate('sub-1', { mode: 'persistent', scope: 'session' }, 'agent-a', 'sess-1');
      expect(manager.activeSessionCount).toBe(1);
    });
  });

  describe('scope isolation', () => {
    it('session scope isolates by sessionId', () => {
      const s1 = manager.getOrCreate('sub-1', { mode: 'persistent', scope: 'session' }, 'agent-a', 'sess-1');
      const s2 = manager.getOrCreate('sub-1', { mode: 'persistent', scope: 'session' }, 'agent-a', 'sess-2');

      expect(s1).not.toBe(s2);
      expect(s1.key).not.toBe(s2.key);
    });

    it('agent scope shares across sessions', () => {
      const s1 = manager.getOrCreate('sub-1', { mode: 'persistent', scope: 'agent' }, 'agent-a', 'sess-1');
      const s2 = manager.getOrCreate('sub-1', { mode: 'persistent', scope: 'agent' }, 'agent-a', 'sess-2');

      expect(s1).toBe(s2); // same agent, shared session
    });

    it('agent scope isolates by agentId', () => {
      const s1 = manager.getOrCreate('sub-1', { mode: 'persistent', scope: 'agent' }, 'agent-a', 'sess-1');
      const s2 = manager.getOrCreate('sub-1', { mode: 'persistent', scope: 'agent' }, 'agent-b', 'sess-1');

      expect(s1).not.toBe(s2);
    });

    it('global scope shares across all agents and sessions', () => {
      const s1 = manager.getOrCreate('sub-1', { mode: 'persistent', scope: 'global' }, 'agent-a', 'sess-1');
      const s2 = manager.getOrCreate('sub-1', { mode: 'persistent', scope: 'global' }, 'agent-b', 'sess-2');

      expect(s1).toBe(s2);
    });
  });

  describe('delete', () => {
    it('deletes a persistent session', () => {
      manager.getOrCreate('sub-1', { mode: 'persistent', scope: 'session' }, 'agent-a', 'sess-1');
      expect(manager.activeSessionCount).toBe(1);

      manager.delete('sub-1', 'session', 'agent-a', 'sess-1');
      expect(manager.activeSessionCount).toBe(0);
    });
  });
});
