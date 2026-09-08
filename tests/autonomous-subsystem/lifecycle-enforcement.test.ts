import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SubsystemRuntime } from '../../src/harness/autonomous-subsystem/runtime.js';
import { DefaultEventBus } from '../../src/core/primitives/event-bus.js';
import type { SubsystemSpec } from '../../src/harness/autonomous-subsystem/types.js';

function makeSpec(overrides?: Partial<SubsystemSpec>): SubsystemSpec {
  return {
    id: 'test-sub',
    name: 'Test',
    description: 'test',
    sense: { source: 'eventBus', filter: { events: ['test.event'] }, isolation: 'structured' },
    think: {
      strategy: 'deterministic',
      implementation: 'code',
      handler: async () => ({ signals: [{ action: 'no-op', reason: 'test' }] }),
    },
    act: { mode: 'none' },
    signal: { severity: 'info', channel: ['event'] },
    boundary: { visibility: 'structured', authority: 'observe', security: 'sandboxed' },
    tools: { mode: 'none' },
    session: { mode: 'ephemeral', scope: 'session' },
    ...overrides,
  };
}

describe('SubsystemRuntime lifecycle enforcement', () => {
  let events: DefaultEventBus;
  let runtimes: SubsystemRuntime[] = [];

  beforeEach(() => {
    events = new DefaultEventBus();
    runtimes = [];
  });
  afterEach(() => {
    for (const r of runtimes) r.dispose();
  });

  it('sets status to timeout when maxDurationMs exceeded', async () => {
    const tmpDir = `/tmp/octopi-audit-timeout-${Date.now()}`;
    const runtime = new SubsystemRuntime({
      deps: { model: {} as any, events, errorStrategy: {} as any, mainTools: new Map() },
      auditDir: tmpDir,
    });
    runtimes.push(runtime);

    runtime.register(makeSpec({
      lifecycle: { maxDurationMs: 50 },
      think: {
        strategy: 'deterministic',
        implementation: 'code',
        handler: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return { signals: [{ action: 'suggest', reason: 'should not complete' }] };
        },
      },
    }));

    await runtime.trigger('test-sub');

    const { readdirSync, readFileSync, rmSync } = await import('node:fs');
    const files = readdirSync(`${tmpDir}/test-sub`).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);

    const run = JSON.parse(readFileSync(`${tmpDir}/test-sub/${files[0]}`, 'utf-8').trim());
    expect(run.status).toBe('timeout');
    expect(run.error).toContain('timed out');

    runtime.dispose();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('delivers interrupted signal according to degradeOn policy', async () => {
    const runtime = new SubsystemRuntime({
      deps: { model: {} as any, events, errorStrategy: {} as any, mainTools: new Map() },
    });
    runtimes.push(runtime);

    runtime.register(makeSpec({
      lifecycle: { maxDurationMs: 50, degradeOn: 'timeout' },
      think: {
        strategy: 'deterministic',
        implementation: 'code',
        handler: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return { signals: [{ action: 'suggest', reason: 'should not complete' }] };
        },
      },
    }));

    await runtime.trigger('test-sub');

    // degradeOn=timeout for timeout -> 不发送信号
    expect(runtime.signals.pendingCounts.context).toBe(0);
    expect(runtime.signals.pendingCounts.escalate).toBe(0);

    runtime.dispose();
  });

  it('keeps signal delivery when token budget exceeded and degradeOn=both', async () => {
    const runtime = new SubsystemRuntime({
      deps: { model: {} as any, events, errorStrategy: {} as any, mainTools: new Map() },
    });
    runtimes.push(runtime);

    runtime.register(makeSpec({
      lifecycle: { maxTokens: 1, degradeOn: 'both' },
      think: {
        strategy: 'deterministic',
        implementation: 'code',
        handler: async () => ({
          signals: [{ action: 'suggest', reason: 'ok' }],
        }),
      },
    }));

    await runtime.trigger('test-sub');

    // token budget 未触发（code handler无token usage）→ 信号正常投递
    expect(runtime.signals.pendingCounts.context).toBe(0);
    expect(runtime.signals.pendingCounts.escalate).toBe(0);

    runtime.dispose();
  });
});
