import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('SubsystemRuntime', () => {
  let events: DefaultEventBus;
  let runtime: SubsystemRuntime;
  let runtimes: SubsystemRuntime[] = [];

  beforeEach(() => {
    events = new DefaultEventBus();
    runtime = new SubsystemRuntime({
      deps: {
        model: {} as any,
        events,
        errorStrategy: {} as any,
        mainTools: new Map(),
      },
    });
    runtimes = [runtime];
  });

  afterEach(() => {
    for (const r of runtimes) r.dispose();
  });

  describe('register / unregister', () => {
    it('registers a valid subsystem', () => {
      const errors = runtime.register(makeSpec());
      expect(errors).toHaveLength(0);
      expect(runtime.subsystemCount).toBe(1);
    });

    it('rejects invalid spec', () => {
      const errors = runtime.register(makeSpec({
        boundary: { visibility: 'structured', authority: 'suggest', security: 'sandboxed' },
        act: { mode: 'block' }, // conflict with suggest
      }));
      expect(errors.length).toBeGreaterThan(0);
      expect(runtime.subsystemCount).toBe(0);
    });

    it('rejects duplicate id', () => {
      runtime.register(makeSpec());
      const errors = runtime.register(makeSpec());
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('already registered');
    });

    it('unregisters a subsystem', () => {
      runtime.register(makeSpec());
      runtime.unregister('test-sub');
      expect(runtime.subsystemCount).toBe(0);
    });
  });

  describe('event-driven triggering', () => {
    it('triggers subsystem on matching event', async () => {
      const handler = vi.fn(async () => ({
        signals: [{ action: 'suggest' as const, reason: 'triggered' }],
      }));

      runtime.register(makeSpec({
        think: { strategy: 'deterministic', implementation: 'code', handler },
      }));

      events.emit({ type: 'test.event', timestamp: Date.now(), data: { key: 'value' } });

      // Wait for async execution
      await new Promise((r) => setTimeout(r, 50));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not trigger on non-matching event', async () => {
      const handler = vi.fn(async () => ({ signals: [] }));
      runtime.register(makeSpec({
        sense: { source: 'eventBus', filter: { events: ['other.event'] }, isolation: 'structured' },
        think: { strategy: 'deterministic', implementation: 'code', handler },
      }));

      events.emit({ type: 'test.event', timestamp: Date.now() });
      await new Promise((r) => setTimeout(r, 50));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('metrics injection', () => {
    it('metrics store is accessible', () => {
      runtime.metrics.update('turn.count', 10);
      expect(runtime.metrics.get('turn.count')).toBe(10);
    });
  });

  describe('signal delivery', () => {
    it('delivers signals through SignalBus', async () => {
      runtime.register(makeSpec({
        think: {
          strategy: 'deterministic',
          implementation: 'code',
          handler: async () => ({
            signals: [
              { action: 'suggest', reason: 'consider this' },
              { action: 'alert', reason: 'warning' },
            ],
          }),
        },
      }));

      events.emit({ type: 'test.event', timestamp: Date.now() });
      await new Promise((r) => setTimeout(r, 50));

      // With spec signal.channel defaulting to event-only, context queue stays empty
      expect(runtime.signals.pendingCounts.context).toBe(0);
      expect(runtime.signals.pendingCounts.escalate).toBe(0);
    });
  });

  describe('audit', () => {
    it('writes audit records on execution', async () => {
      const tmpDir = '/tmp/octopi-audit-test-' + Date.now();
      const { mkdirSync } = await import('node:fs');

      const rt = new SubsystemRuntime({
        deps: { model: {} as any, events, errorStrategy: {} as any, mainTools: new Map() },
        auditDir: tmpDir,
      });

      rt.register(makeSpec());
      events.emit({ type: 'test.event', timestamp: Date.now() });
      await new Promise((r) => setTimeout(r, 50));

      // Audit file should exist
      const { existsSync, readdirSync, rmSync } = await import('node:fs');
      const auditSubDir = `${tmpDir}/test-sub`;
      expect(existsSync(auditSubDir)).toBe(true);
      const files = readdirSync(auditSubDir).filter((f) => f.endsWith('.jsonl'));
      expect(files.length).toBeGreaterThan(0);

      runtimes.push(rt);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes audit even on failure', async () => {
      const tmpDir = '/tmp/octopi-audit-fail-test-' + Date.now();

      const rt = new SubsystemRuntime({
        deps: { model: {} as any, events, errorStrategy: {} as any, mainTools: new Map() },
        auditDir: tmpDir,
      });

      rt.register(makeSpec({
        think: {
          strategy: 'deterministic',
          implementation: 'code',
          handler: async () => { throw new Error('intentional failure'); },
        },
      }));

      events.emit({ type: 'test.event', timestamp: Date.now() });
      await new Promise((r) => setTimeout(r, 50));

      const { existsSync, readFileSync, rmSync } = await import('node:fs');
      const auditSubDir = `${tmpDir}/test-sub`;
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(auditSubDir).filter((f) => f.endsWith('.jsonl'));
      expect(files.length).toBeGreaterThan(0);

      const content = readFileSync(`${auditSubDir}/${files[0]}`, 'utf-8');
      const run = JSON.parse(content.trim().split('\n')[0]);
      expect(run.status).toBe('failed');
      expect(run.error).toContain('intentional failure');

      runtimes.push(rt);
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
