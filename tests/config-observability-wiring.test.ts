/**
 * observability 配置接线（F3-b / D5）
 *
 * 背景：`observability.traceDir/level` 曾流到 `gatewayConfig.trace` 后无人消费
 * （断头线）。现在经 `wireObservability`（组合根）接 `AgentBuilder.trace()`：
 * trace 落盘（TraceCollector → JSONL）+ 采集意图。本测试锁三件事：
 * 1. `toGatewayConfig` 不静默丢弃 observability 段（边界字面量漏字段回归）
 * 2. 工厂产出的 RunTelemetry 真把 `model.call.*` 落进 traceDir（F3 回归指标通道）
 * 3. `wireObservability` 的装配语义（缺省 no-op；显式配置进 trace options）
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toGatewayConfig } from '../src/config.js';
import type { NormalizedHarnessConfig } from '../src/config.js';
import {
  createTelemetryFactoryFromConfig,
  wireObservability,
} from '@octopi-agent/engine/config.js';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';

function minimalConfig(extra: Partial<NormalizedHarnessConfig>): NormalizedHarnessConfig {
  return {
    models: { providers: {} },
    agents: [],
    flatModels: [],
    ...extra,
  } as unknown as NormalizedHarnessConfig;
}

describe('toGatewayConfig observability 保全', () => {
  it('observability 段原样过界（traceDir/level/capture* 不丢）', () => {
    const observability = {
      level: 4,
      consoleLevel: null,
      traceDir: '/tmp/traces',
      captureStreamDeltas: true,
    };
    const gw = toGatewayConfig(minimalConfig({ observability }));
    expect(gw.observability).toEqual(observability);
  });

  it('未配置时 observability 保持缺省（不注入空对象）', () => {
    const gw = toGatewayConfig(minimalConfig({}));
    expect(gw.observability).toBeUndefined();
  });
});

describe('createTelemetryFactoryFromConfig 落盘', () => {
  it('model.call.start/end 经 LoopObserver 落 traceDir JSONL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-trace-'));
    const factory = await createTelemetryFactoryFromConfig({ level: 3, traceDir: dir });
    const telemetry = factory({
      captureStreamDeltas: false,
      captureModelRequest: false,
      captureToolArgs: true,
      captureToolResults: false,
      enableMetrics: true,
    });

    const observer = telemetry.createLoopObserver({});
    observer.onLLMStart?.({ model: 'm1' });
    // 间隔数毫秒：durationMs 必须 > 0（=0 说明计时器失效也测不出）
    await new Promise((r) => setTimeout(r, 5));
    observer.onLLMEnd?.({ model: 'm1' });
    await telemetry.finalize?.();

    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBe(1);
    const lines = readFileSync(join(dir, files[0]), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; data?: Record<string, unknown> });

    const types = lines.map((l) => l.type);
    expect(types).toContain('model.call.start');
    expect(types).toContain('model.call.end');
    // F3 回归指标口径：end 必带 model + durationMs（ttft/chars 段在 F3-c 扩展）
    const end = lines.find((l) => l.type === 'model.call.end');
    expect(end?.data?.model).toBe('m1');
    expect(typeof end?.data?.durationMs).toBe('number');
    expect(end?.data?.durationMs as number).toBeGreaterThan(0);
    expect(types).toContain('trace.start');
    expect(types).toContain('trace.end');
  });

  it('同秒多实例不共写一个文件（文件名毫秒+pid+序号唯一化）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-trace-'));
    const factory = await createTelemetryFactoryFromConfig({ traceDir: dir });
    const t1 = factory({ enableMetrics: true });
    const t2 = factory({ enableMetrics: true });
    t1.createLoopObserver({}).onLLMStart?.({ model: 'a' });
    t2.createLoopObserver({}).onLLMStart?.({ model: 'b' });
    await t1.finalize?.();
    await t2.finalize?.();

    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBe(2);
  });

  it('level 过滤生效（默认 level=3 拦 DEBUG 事件）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-trace-'));
    const factory = await createTelemetryFactoryFromConfig({ traceDir: dir });
    const telemetry = factory({ enableMetrics: true });
    const observer = telemetry.createLoopObserver({});
    // DEBUG 级的 context.built 不应落盘（level 缺省 3 = INFO）
    telemetry.onEvent?.(
      { type: 'context.built', timestamp: Date.now(), data: {} } as never,
      { sessionId: 's', agentId: 'a' },
    );
    observer.onLLMStart?.({ model: 'm1' });
    await telemetry.finalize?.();

    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    const types = readFileSync(join(dir, files[0]), 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).not.toContain('context.built');
    expect(types).toContain('model.call.start');
  });
});

describe('wireObservability 装配语义', () => {
  it('缺省 no-op：不设 trace options', async () => {
    const builder = new AgentBuilder();
    await wireObservability(builder, undefined);
    expect(builder.getTraceOptions()).toBeUndefined();
  });

  it('显式配置：capture 意图进 trace options', async () => {
    const builder = new AgentBuilder();
    await wireObservability(builder, {
      captureStreamDeltas: true,
      captureModelRequest: true,
      traceDir: '/tmp/traces',
    });
    const opts = builder.getTraceOptions();
    expect(opts?.captureStreamDeltas).toBe(true);
    expect(opts?.captureModelRequest).toBe(true);
  });
});
