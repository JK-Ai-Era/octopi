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

describe('SubsystemRuntime timeout enforcement', () => {
  let events: DefaultEventBus;
  let runtimes: SubsystemRuntime[] = [];

  beforeEach(() => {
    events = new DefaultEventBus();
    runtimes = [];
  });

  afterEach(() => {
    for (const r of runtimes) {
      r.dispose();
    }
  });

  it('marks run as timeout when handler exceeds maxDurationMs', async () => {
    const tmpDir = `/tmp/octopi-timeout-test-${Date.now()}`;
    const runtime = new SubsystemRuntime({
      deps: {
        model: {} as any,
        events,
        errorStrategy: {} as any,
        mainTools: new Map(),
      },
      auditDir: tmpDir,
    });
    runtimes.push(runtime);

    runtime.register(
      makeSpec({
        lifecycle: {
          maxDurationMs: 50,
          degradeOn: 'timeout',
        },
        think: {
          strategy: 'deterministic',
          implementation: 'code',
          handler: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return {
              signals: [{ action: 'suggest', reason: 'should not complete' }],
            };
          },
        },
      }),
    );

    await runtime.trigger('test-sub');

    const { readdirSync, readFileSync, rmSync } = await import('node:fs');
    const files = readdirSync(`${tmpDir}/test-sub`).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);

    const run = JSON.parse(readFileSync(`${tmpDir}/test-sub/${files[0]}`, 'utf-8').trim());
    expect(run.status).toBe('timeout');
    expect(run.error).toContain('timed out');
    expect(runtime.signals.pendingCounts.context).toBe(0);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
