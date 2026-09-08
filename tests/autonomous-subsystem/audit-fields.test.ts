import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SubsystemRuntime } from '../../src/harness/autonomous-subsystem/runtime.js';
import { DefaultEventBus } from '../../src/core/primitives/event-bus.js';
import type { SubsystemSpec } from '../../src/harness/autonomous-subsystem/types.js';

function makeSpec(overrides?: Partial<SubsystemSpec>): SubsystemSpec {
  return {
    id: 'audit-sub',
    name: 'Audit Subsystem',
    description: 'audit field validation',
    sense: { source: 'eventBus', filter: { events: ['run'] }, isolation: 'structured' },
    think: {
      strategy: 'deterministic',
      implementation: 'code',
      handler: async () => ({
        signals: [{ action: 'suggest', reason: 'audit-ok', confidence: 0.7, data: { note: true } }],
      }),
    },
    act: { mode: 'none' },
    signal: { severity: 'info', channel: ['event'] },
    boundary: { visibility: 'structured', authority: 'observe', security: 'sandboxed' },
    tools: { mode: 'none' },
    session: { mode: 'ephemeral', scope: 'session' },
    ...overrides,
  };
}

describe('SubsystemRuntime audit field completeness', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'octopi-audit-fields-'));
  let events: DefaultEventBus;
  let runtime: SubsystemRuntime;

  beforeEach(() => {
    events = new DefaultEventBus();
    runtime = new SubsystemRuntime({
      deps: { model: {} as any, events, errorStrategy: {} as any, mainTools: new Map() },
      auditDir: tmpDir,
    });
  });

  afterEach(() => {
    runtime.dispose();
  });

  it('writes structured fields for successful run', async () => {
    runtime.register(makeSpec());

    events.emit({ type: 'run', timestamp: Date.now(), data: { hello: 'world' } });
    await new Promise((r) => setTimeout(r, 50));

    const files = readdirSync(join(tmpDir, 'audit-sub')).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);

    const run = JSON.parse(readFileSync(join(tmpDir, 'audit-sub', files[0]), 'utf-8').trim());
    expect(run.status).toBe('success');
    expect(run.input).toBeDefined();
    expect(run.output).toBeDefined();
    expect(Array.isArray(run.signals)).toBe(true);
    expect(Array.isArray(run.acts)).toBe(true);
    expect(typeof run.durationMs).toBe('number');
    expect(typeof run.timestamp).toBe('number');
    expect(run.sessionKey).toBeDefined();
    expect(run.tokenUsage).toBeDefined();
    expect(run.tokenUsage.prompt).toBeGreaterThan(0);
    expect(run.tokenUsage.completion).toBeGreaterThan(0);
    expect(run.tokenUsage.total).toBeGreaterThan(0);
  });

  it('keeps fields populated on handler failure', async () => {
    runtime.register(
      makeSpec({
        think: {
          strategy: 'deterministic',
          implementation: 'code',
          handler: async () => {
            throw new Error('boom');
          },
        },
      }),
    );

    events.emit({ type: 'run', timestamp: Date.now(), data: {} });
    await new Promise((r) => setTimeout(r, 50));

    const files = readdirSync(join(tmpDir, 'audit-sub')).filter((f) => f.endsWith('.jsonl'));
    const content = readFileSync(join(tmpDir, 'audit-sub', files[files.length - 1]), 'utf-8').trim();
    const run = JSON.parse(content.split('\n').at(-1)!);

    expect(run.status).toBe('failed');
    expect(run.error).toContain('boom');
    expect(run.input).toBeDefined();
    expect(run.output).toBeUndefined();
    expect(Array.isArray(run.signals)).toBe(true);
    expect(Array.isArray(run.acts)).toBe(true);
  });
});
