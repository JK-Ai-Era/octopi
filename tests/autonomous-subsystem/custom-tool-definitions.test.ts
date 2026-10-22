import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubsystemRuntime } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/runtime.js';
import { DefaultToolBus } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/tool-bus.js';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { SubsystemSpec } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/types.js';

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
      deps: { model: {} as any, events, errorStrategy: {} as any, mainTools: new DefaultToolBus() },
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
                parameters: {},
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
