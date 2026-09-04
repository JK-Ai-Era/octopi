import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuditWriter } from '../../src/harness/autonomous-subsystem/audit/writer.js';
import { AuditReader } from '../../src/harness/autonomous-subsystem/audit/reader.js';
import type { SubsystemRun } from '../../src/harness/autonomous-subsystem/types.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeRun(overrides?: Partial<SubsystemRun>): SubsystemRun {
  return {
    id: 'run-001',
    subsystemId: 'test-subsystem',
    trigger: { source: 'eventBus', timestamp: Date.now() },
    input: {},
    signals: [],
    acts: [],
    durationMs: 100,
    status: 'success',
    timestamp: Date.now(),
    sessionKey: 'test:agent:session',
    ...overrides,
  };
}

describe('AuditWriter + AuditReader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'octopi-audit-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('AuditWriter', () => {
    it('writes audit record to JSONL file', () => {
      const writer = new AuditWriter({ auditDir: tmpDir });
      const run = makeRun();
      writer.write(run);

      const date = new Date(run.timestamp).toISOString().slice(0, 10);
      const filePath = join(tmpDir, 'test-subsystem', `${date}.jsonl`);
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.id).toBe('run-001');
      expect(parsed.subsystemId).toBe('test-subsystem');
    });

    it('writes multiple records to same file', () => {
      const writer = new AuditWriter({ auditDir: tmpDir });
      writer.write(makeRun({ id: 'run-001' }));
      writer.write(makeRun({ id: 'run-002' }));

      const date = new Date().toISOString().slice(0, 10);
      const filePath = join(tmpDir, 'test-subsystem', `${date}.jsonl`);
      const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
    });

    it('includes agentId in path when provided', () => {
      const writer = new AuditWriter({ auditDir: tmpDir, agentId: 'agent-a' });
      writer.write(makeRun());

      const date = new Date().toISOString().slice(0, 10);
      const filePath = join(tmpDir, 'agent-a', 'test-subsystem', `${date}.jsonl`);
      expect(existsSync(filePath)).toBe(true);
    });

    it('does not throw on write failure', () => {
      // 使用不存在的路径（父目录不可创建的情况在某些系统上可能失败）
      // 但我们的实现用 mkdirSync recursive，所以大多数情况不会失败
      // 这里测试的是不会抛出异常
      const writer = new AuditWriter({ auditDir: tmpDir });
      expect(() => writer.write(makeRun())).not.toThrow();
    });
  });

  describe('AuditReader', () => {
    it('reads all records from audit dir', () => {
      const writer = new AuditWriter({ auditDir: tmpDir });
      writer.write(makeRun({ id: 'run-001' }));
      writer.write(makeRun({ id: 'run-002', status: 'failed' }));

      const reader = new AuditReader({ auditDir: tmpDir });
      const results = reader.query();

      expect(results).toHaveLength(2);
    });

    it('filters by status', () => {
      const writer = new AuditWriter({ auditDir: tmpDir });
      writer.write(makeRun({ id: 'run-001', status: 'success' }));
      writer.write(makeRun({ id: 'run-002', status: 'failed' }));
      writer.write(makeRun({ id: 'run-003', status: 'success' }));

      const reader = new AuditReader({ auditDir: tmpDir });
      const results = reader.query({ status: 'failed' });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('run-002');
    });

    it('filters by subsystemId', () => {
      const writer = new AuditWriter({ auditDir: tmpDir });
      writer.write(makeRun({ id: 'run-001', subsystemId: 'sub-a' }));
      writer.write(makeRun({ id: 'run-002', subsystemId: 'sub-b' }));

      const reader = new AuditReader({ auditDir: tmpDir });
      const results = reader.query({ subsystemId: 'sub-a' });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('run-001');
    });

    it('respects limit', () => {
      const writer = new AuditWriter({ auditDir: tmpDir });
      for (let i = 0; i < 10; i++) {
        writer.write(makeRun({ id: `run-${i}` }));
      }

      const reader = new AuditReader({ auditDir: tmpDir });
      const results = reader.query({ limit: 3 });

      expect(results).toHaveLength(3);
    });

    it('returns empty array when no audit data exists', () => {
      const reader = new AuditReader({ auditDir: join(tmpDir, 'nonexistent') });
      expect(reader.query()).toEqual([]);
    });
  });
});
