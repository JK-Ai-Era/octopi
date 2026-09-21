/**
 * SessionLedger P4 测试
 *
 * 测试 session 级账本的多 run 累计功能。
 */

import { describe, it, expect } from 'vitest';
import { SessionLedger } from '../../../src/harness/accounting/session-ledger.js';
import type { UsageLedgerSnapshot } from '../../../src/harness/accounting/usage-ledger.js';

function createMockRunSnapshot(overrides?: Partial<UsageLedgerSnapshot>): UsageLedgerSnapshot {
  return {
    scope: 'run',
    sessionId: 'test-session',
    agentId: 'test-agent',
    cacheAware: false,
    llmCalls: 5,
    inputUncachedTokens: 1000,
    inputCachedTokens: 0,
    inputCacheWriteTokens: 0,
    outputTokens: 500,
    nominalTotalTokens: 1500,
    summaryLlmCalls: 1,
    summaryOutputTokens: 100,
    toolCalls: 3,
    elapsedMs: 60000,
    ...overrides,
  };
}

describe('SessionLedger', () => {
  it('初始化为空状态', () => {
    const ledger = new SessionLedger('session-1', 'agent-1');
    const snapshot = ledger.snapshot();

    expect(snapshot.sessionId).toBe('session-1');
    expect(snapshot.agentId).toBe('agent-1');
    expect(snapshot.runCount).toBe(0);
    expect(snapshot.llmCalls).toBe(0);
    expect(snapshot.inputUncachedTokens).toBe(0);
    expect(snapshot.outputTokens).toBe(0);
    expect(snapshot.nominalTotalTokens).toBe(0);
    expect(snapshot.toolCalls).toBe(0);
    expect(snapshot.firstRunAt).toBe(0);
    expect(snapshot.lastRunAt).toBe(0);
    expect(snapshot.totalElapsedMs).toBe(0);
  });

  it('合并单个 run 快照', () => {
    const ledger = new SessionLedger('session-1');
    const runSnapshot = createMockRunSnapshot();

    ledger.mergeRunSnapshot(runSnapshot);
    const snapshot = ledger.snapshot();

    expect(snapshot.runCount).toBe(1);
    expect(snapshot.llmCalls).toBe(5);
    expect(snapshot.inputUncachedTokens).toBe(1000);
    expect(snapshot.outputTokens).toBe(500);
    expect(snapshot.nominalTotalTokens).toBe(1500);
    expect(snapshot.summaryLlmCalls).toBe(1);
    expect(snapshot.summaryOutputTokens).toBe(100);
    expect(snapshot.toolCalls).toBe(3);
    expect(snapshot.totalElapsedMs).toBe(60000);
    expect(snapshot.firstRunAt).toBeGreaterThan(0);
    expect(snapshot.lastRunAt).toBeGreaterThanOrEqual(snapshot.firstRunAt);
  });

  it('合并多个 run 快照正确累计', () => {
    const ledger = new SessionLedger('session-1');

    ledger.mergeRunSnapshot(createMockRunSnapshot({
      llmCalls: 5,
      inputUncachedTokens: 1000,
      outputTokens: 500,
      toolCalls: 3,
      elapsedMs: 60000,
    }));

    ledger.mergeRunSnapshot(createMockRunSnapshot({
      llmCalls: 10,
      inputUncachedTokens: 2000,
      outputTokens: 1000,
      nominalTotalTokens: 3000, // 2000 + 1000
      toolCalls: 6,
      elapsedMs: 120000,
    }));

    const snapshot = ledger.snapshot();

    expect(snapshot.runCount).toBe(2);
    expect(snapshot.llmCalls).toBe(15); // 5 + 10
    expect(snapshot.inputUncachedTokens).toBe(3000); // 1000 + 2000
    expect(snapshot.outputTokens).toBe(1500); // 500 + 1000
    expect(snapshot.nominalTotalTokens).toBe(4500); // 1500 + 3000
    expect(snapshot.toolCalls).toBe(9); // 3 + 6
    expect(snapshot.totalElapsedMs).toBe(180000); // 60000 + 120000
  });

  it('cacheAware 一旦为 true 不回退', () => {
    const ledger = new SessionLedger('session-1');

    ledger.mergeRunSnapshot(createMockRunSnapshot({ cacheAware: false }));
    expect(ledger.snapshot().cacheAware).toBe(false);

    ledger.mergeRunSnapshot(createMockRunSnapshot({ cacheAware: true }));
    expect(ledger.snapshot().cacheAware).toBe(true);

    ledger.mergeRunSnapshot(createMockRunSnapshot({ cacheAware: false }));
    expect(ledger.snapshot().cacheAware).toBe(true); // 保持 true
  });

  it('summary 归因正确累计', () => {
    const ledger = new SessionLedger('session-1');

    ledger.mergeRunSnapshot(createMockRunSnapshot({
      summaryLlmCalls: 2,
      summaryOutputTokens: 200,
    }));

    ledger.mergeRunSnapshot(createMockRunSnapshot({
      summaryLlmCalls: 3,
      summaryOutputTokens: 300,
    }));

    const snapshot = ledger.snapshot();

    expect(snapshot.summaryLlmCalls).toBe(5); // 2 + 3
    expect(snapshot.summaryOutputTokens).toBe(500); // 200 + 300
  });

  it('firstRunAt 和 lastRunAt 时序正确', () => {
    const ledger = new SessionLedger('session-1');

    ledger.mergeRunSnapshot(createMockRunSnapshot({ elapsedMs: 1000 }));
    const firstSnapshot = ledger.snapshot();
    expect(firstSnapshot.firstRunAt).toBeGreaterThan(0);
    expect(firstSnapshot.lastRunAt).toBeGreaterThanOrEqual(firstSnapshot.firstRunAt);

    // 等待一小段时间再合并第二个 run
    const firstRunAt = firstSnapshot.firstRunAt;

    ledger.mergeRunSnapshot(createMockRunSnapshot({ elapsedMs: 2000 }));
    const secondSnapshot = ledger.snapshot();

    expect(secondSnapshot.firstRunAt).toBe(firstRunAt); // 不变
    expect(secondSnapshot.lastRunAt).toBeGreaterThanOrEqual(firstRunAt);
  });
});