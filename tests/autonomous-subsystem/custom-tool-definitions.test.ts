import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubsystemRuntime } from '../../src/harness/autonomous-subsystem/runtime.js';
import { DefaultEventBus } from '../../src/core/primitives/event-bus.js';
import type { SubsystemSpec } from '../../src/harness/autonomous-subsystem/types.js';

const events = new DefaultEventBus();

function makeSpec(overrides?: Partial<SubsystemSpec>): SubsystemSpec {
  return {
    id: 'tool-sub',
    name: 'Tool Subsystem',
    description: 'test',
    sense: { source: 'eventBus', filter: { events: ['run'] }, isolation: 'structured' },
    think: {
      strategy: 'deterministic',
      implementation: 'code',
      handler: async () => ({ signals: [{ action: 'suggest', reason: 'done' }] }),
    },
    act: { mode: 'none' },
    signal: { severity: 'info', channel: ['event'] },
    boundary: { visibility: 'structured', authority: 'observe', security: 'sandboxed' },
    tools: { mode: 'none' },
    session: { mode: 'ephemeral', scope: 'session' },
    ...overrides,
  };
}

describe('SubsystemRuntime custom tools from definitions', () => {
  let runtime: SubsystemRuntime;

  beforeEach(() => {
    runtime = new SubsystemRuntime({
      deps: { model: {} as any, events, errorStrategy: {} as any, mainTools: new Map() },
    });
  });

  afterEach(() => {
    runtime.dispose();
  });

  it('exposes definitions to runtime tool resolution', async () => {
    const handler = vi.fn(async () => 'ok');

    runtime.register(
      makeSpec({
        tools: {
          mode: 'custom',
          definitions: [
            {
              definition: {
                name: 'analyze',
                description: 'analyze content',
                parameters: { type: 'object', properties: {}, required: [] },
              },
              handler,
            },
          ],
        },
      }),
    );

    expect(runtime.subsystemCount).toBe(1);
  });
});
