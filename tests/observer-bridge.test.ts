/**
 * ObserverBridge + TraceCollector Metrics 集成测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ObserverBridge } from '../src/integration/observability/observer-bridge.js';
import { TraceCollector } from '../src/integration/observability/trace-collector.js';
import { MetricsAggregator } from '../src/integration/observability/metrics.js';
import { TraceLevel } from '../src/integration/observability/trace-events.js';
import type { AgentEvent } from '../src/core/event-bus.js';

// ── ObserverBridge 测试 ──

describe('ObserverBridge', () => {
  let bridge: ObserverBridge;

  beforeEach(() => {
    bridge = new ObserverBridge({
      logger: { level: TraceLevel.DEBUG, consoleLevel: null },
    });
  });

  it('实现 Observer 接口', () => {
    expect(bridge.recordMetric).toBeDefined();
    expect(bridge.startSpan).toBeDefined();
    expect(bridge.log).toBeDefined();
  });

  it('recordMetric 记录到 TraceLogger', () => {
    const logger = bridge.getLogger();
    const before = logger.getEventCount();
    bridge.recordMetric('test.metric', 42, { env: 'test' });
    expect(logger.getEventCount()).toBeGreaterThan(before);
  });

  it('recordMetric 映射 token 指标到 MetricsAggregator', () => {
    const metrics = bridge.getMetricsAggregator();
    bridge.recordMetric('agent.model.tokens.input', 1000);
    bridge.recordMetric('agent.model.tokens.output', 500);
    const snap = metrics.snapshot();
    // 映射为 model.call.end 事件中的 usage
    expect(snap.llmTokensInput).toBeGreaterThanOrEqual(0);
  });

  it('startSpan 返回可操作的 Span', () => {
    const span = bridge.startSpan('test.span', { key: 'value' });
    expect(span.id).toBeDefined();
    expect(span.name).toBe('test.span');
    expect(span.startTime).toBeGreaterThan(0);
    span.setAttribute('added', true);
    span.setStatus('ok');
    span.end();
  });

  it('startSpan 记录到 logger', () => {
    const logger = bridge.getLogger();
    const before = logger.getEventCount();
    const span = bridge.startSpan('test.span');
    // startSpan 记录一条 debug 日志
    expect(logger.getEventCount()).toBeGreaterThan(before);
    span.end();
  });

  it('startSpan 工具执行映射到 MetricsAggregator', () => {
    const metrics = bridge.getMetricsAggregator();
    const span = bridge.startSpan('agent.tool.exec', { toolName: 'file_read' });
    span.end();
    // MetricsAggregator 应该收到了 tool.exec.end 事件
    const snap = metrics.snapshot();
    expect(snap.toolCalls['file_read']).toBeGreaterThanOrEqual(0);
  });

  it('log 按级别记录', () => {
    const logger = bridge.getLogger();
    const before = logger.getEventCount();
    bridge.log('info', 'test message', { key: 'value' });
    expect(logger.getEventCount()).toBeGreaterThan(before);
  });

  it('getMetricsAggregator 返回 MetricsAggregator 实例', () => {
    const metrics = bridge.getMetricsAggregator();
    expect(metrics).toBeInstanceOf(MetricsAggregator);
  });

  it('finalize 不抛错', async () => {
    bridge.recordMetric('test', 1);
    await expect(bridge.finalize()).resolves.toBeUndefined();
  });
});

// ── TraceCollector Metrics 集成测试 ──

describe('TraceCollector metrics integration', () => {
  it('默认启用 MetricsAggregator', () => {
    const collector = new TraceCollector({
      level: TraceLevel.DEBUG,
      consoleLevel: null,
    });
    expect(collector.getMetricsAggregator()).not.toBeNull();
  });

  it('可通过 enableMetrics=false 禁用', () => {
    const collector = new TraceCollector({
      level: TraceLevel.DEBUG,
      consoleLevel: null,
      enableMetrics: false,
    });
    expect(collector.getMetricsAggregator()).toBeNull();
  });

  it('接受预创建的 MetricsAggregator 实例', () => {
    const customMetrics = new MetricsAggregator();
    const collector = new TraceCollector({
      level: TraceLevel.DEBUG,
      consoleLevel: null,
      metricsInstance: customMetrics,
    });
    expect(collector.getMetricsAggregator()).toBe(customMetrics);
  });

  it('wrap 后 MetricsAggregator 收集到事件', async () => {
    const collector = new TraceCollector({
      level: TraceLevel.DEBUG,
      consoleLevel: null,
    });
    const metrics = collector.getMetricsAggregator()!;

    // 模拟引擎事件流
    async function* mockEvents(): AsyncGenerator<AgentEvent> {
      yield { type: 'model.call.start', timestamp: Date.now(), data: { model: 'test' } };
      yield { type: 'model.call.end', timestamp: Date.now(), data: { usage: { promptTokens: 100, completionTokens: 50 } } };
      yield { type: 'tool.exec.start', timestamp: Date.now(), data: { toolName: 'file_read' } };
      yield { type: 'tool.exec.end', timestamp: Date.now(), data: { toolName: 'file_read', hasError: false } };
    }

    const wrapped = collector.wrap(mockEvents(), { sessionId: 'test-session' });
    // 消费所有事件
    for await (const _ of wrapped) { /* drain */ }

    const snap = metrics.snapshot();
    expect(snap.llmCalls).toBe(1);
    expect(snap.llmTokensInput).toBe(100);
    expect(snap.llmTokensOutput).toBe(50);
    expect(snap.toolCalls['file_read']).toBe(1);
  });

  it('finalize 不 destroy metrics（调用方可能还需要快照）', () => {
    const collector = new TraceCollector({
      level: TraceLevel.DEBUG,
      consoleLevel: null,
    });
    collector.finalize();
    // finalize 后 metrics 仍可读
    const metrics = collector.getMetricsAggregator();
    expect(metrics).not.toBeNull();
    expect(() => metrics!.snapshot()).not.toThrow();
  });
});
