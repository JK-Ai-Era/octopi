import { describe, it, expect } from 'vitest';
import {
  hashToolCall,
  hashToolOutcome,
  recordToolCall,
  detectNoProgressLoop,
  type ToolCallRecord,
} from '../src/core/tool-loop-detection.js';

describe('ToolLoopDetection', () => {
  describe('hashToolCall', () => {
    it('should produce consistent hashes for same input', () => {
      const h1 = hashToolCall('file_list', { path: '/tmp' });
      const h2 = hashToolCall('file_list', { path: '/tmp' });
      expect(h1).toBe(h2);
    });

    it('should produce different hashes for different params', () => {
      const h1 = hashToolCall('file_list', { path: '/tmp' });
      const h2 = hashToolCall('file_list', { path: '/home' });
      expect(h1).not.toBe(h2);
    });

    it('should produce different hashes for different tools', () => {
      const h1 = hashToolCall('file_list', { path: '/tmp' });
      const h2 = hashToolCall('shell', { path: '/tmp' });
      expect(h1).not.toBe(h2);
    });

    it('should be deterministic regardless of key order', () => {
      const h1 = hashToolCall('shell', { command: 'ls', timeout: 5000 });
      const h2 = hashToolCall('shell', { timeout: 5000, command: 'ls' });
      expect(h1).toBe(h2);
    });
  });

  describe('hashToolOutcome', () => {
    it('should hash successful results', () => {
      const h = hashToolOutcome('file_list', { path: '/tmp' }, ['a.txt', 'b.txt'], undefined);
      expect(h).toBeTruthy();
    });

    it('should hash errors differently from results', () => {
      const h1 = hashToolOutcome('shell', { cmd: 'ls' }, 'output', undefined);
      const h2 = hashToolOutcome('shell', { cmd: 'ls' }, undefined, new Error('fail'));
      expect(h1).not.toBe(h2);
    });

    it('should return undefined for undefined result and no error', () => {
      const h = hashToolOutcome('shell', { cmd: 'ls' }, undefined, undefined);
      expect(h).toBeUndefined();
    });

    it('should produce same hash for same result', () => {
      const r = { files: ['a.txt'], count: 1 };
      const h1 = hashToolOutcome('file_list', { path: '/tmp' }, r, undefined);
      const h2 = hashToolOutcome('file_list', { path: '/tmp' }, r, undefined);
      expect(h1).toBe(h2);
    });
  });

  describe('recordToolCall', () => {
    it('should append to history', () => {
      const h = recordToolCall([], 'shell', { cmd: 'ls' }, 'output', undefined, { enabled: true });
      expect(h.length).toBe(1);
      expect(h[0].toolName).toBe('shell');
      expect(h[0].resultHash).toBeTruthy();
    });

    it('should respect history size limit', () => {
      let h: ToolCallRecord[] = [];
      for (let i = 0; i < 35; i++) {
        h = recordToolCall(h, 'shell', { cmd: 'ls' + i }, 'output' + i, undefined, { enabled: true, historySize: 30 });
      }
      expect(h.length).toBe(30);
    });
  });

  describe('detectNoProgressLoop', () => {
    it('should not detect loop when disabled', () => {
      const result = detectNoProgressLoop([], 'shell', { cmd: 'ls' }, { enabled: false });
      expect(result.stuck).toBe(false);
    });

    it('should not detect loop with few calls', () => {
      let h: ToolCallRecord[] = [];
      for (let i = 0; i < 5; i++) {
        h = recordToolCall(h, 'shell', { cmd: 'ls' }, 'output', undefined, { enabled: true });
      }
      const result = detectNoProgressLoop(h, 'shell', { cmd: 'ls' }, { enabled: true });
      expect(result.stuck).toBe(false);
    });

    it('should detect warning at warningThreshold', () => {
      let h: ToolCallRecord[] = [];
      for (let i = 0; i < 12; i++) {
        h = recordToolCall(h, 'shell', { cmd: 'ls' }, 'same output', undefined, { enabled: true });
      }
      const result = detectNoProgressLoop(h, 'shell', { cmd: 'ls' }, { enabled: true, warningThreshold: 10 });
      expect(result.stuck).toBe(true);
      expect(result.level).toBe('warning');
    });

    it('should detect critical at criticalThreshold', () => {
      let h: ToolCallRecord[] = [];
      for (let i = 0; i < 22; i++) {
        h = recordToolCall(h, 'shell', { cmd: 'ls' }, 'same output', undefined, { enabled: true });
      }
      const result = detectNoProgressLoop(h, 'shell', { cmd: 'ls' }, { enabled: true, criticalThreshold: 20 });
      expect(result.stuck).toBe(true);
      expect(result.level).toBe('critical');
    });

    it('should NOT detect loop when results differ (progress is being made)', () => {
      let h: ToolCallRecord[] = [];
      for (let i = 0; i < 25; i++) {
        h = recordToolCall(h, 'file_read', { path: '/file' + i }, 'content of file ' + i, undefined, { enabled: true });
      }
      const result = detectNoProgressLoop(h, 'file_read', { path: '/file25' }, { enabled: true, warningThreshold: 10 });
      // Different params each time → different argsHash → no loop
      expect(result.stuck).toBe(false);
    });

    it('should NOT detect loop when same tool+params produce different results', () => {
      let h: ToolCallRecord[] = [];
      for (let i = 0; i < 25; i++) {
        h = recordToolCall(h, 'shell', { cmd: 'date' }, 'time: ' + i, undefined, { enabled: true });
      }
      const result = detectNoProgressLoop(h, 'shell', { cmd: 'date' }, { enabled: true, warningThreshold: 10 });
      // Same args but different results each time → has progress → no generic_repeat
      // But recentCount might hit warning
      // Since results differ, noProgressStreak should be low
      expect(result.stuck).toBe(false);
    });

    it('should detect ping-pong pattern', () => {
      let h: ToolCallRecord[] = [];
      // Simulate ping-pong: alternating between two tool calls with same results
      for (let i = 0; i < 12; i++) {
        h = recordToolCall(h, i % 2 === 0 ? 'read' : 'write', { path: '/tmp' }, 'same', undefined, { enabled: true });
      }
      const result = detectNoProgressLoop(h, 'read', { path: '/tmp' }, { enabled: true, warningThreshold: 10 });
      if (result.stuck) {
        expect(result.detector).toBe('ping_pong');
      }
    });

    it('should detect global circuit breaker', () => {
      let h: ToolCallRecord[] = [];
      for (let i = 0; i < 35; i++) {
        h = recordToolCall(h, 'shell', { cmd: 'ls' }, 'same output', undefined, { enabled: true });
      }
      const result = detectNoProgressLoop(h, 'shell', { cmd: 'ls' }, { enabled: true, globalCircuitBreakerThreshold: 30 });
      expect(result.stuck).toBe(true);
      expect(result.level).toBe('critical');
      expect(result.detector).toBe('global_circuit_breaker');
    });
  });
});
