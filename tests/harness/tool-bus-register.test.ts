/**
 * ToolBus.register — duplicate names must not silently shadow tools.
 */
import { describe, it, expect } from 'vitest';

import { DefaultToolBus } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/tool-bus.js';
import type { RegisteredTool } from '@octopi-agent/core/types.js';

function tool(name: string): RegisteredTool {
  return {
    definition: {
      name,
      description: name,
      parameters: {},
    },
    handler: async () => ({ ok: true }),
  } as unknown as RegisteredTool;
}

describe('DefaultToolBus.register', () => {
  it('throws on duplicate name without replace', () => {
    const bus = new DefaultToolBus();
    bus.register(tool('file_write'));
    expect(() => bus.register(tool('file_write'))).toThrow(/already registered/);
  });

  it('allows explicit replace', () => {
    const bus = new DefaultToolBus();
    bus.register(tool('file_write'));
    bus.register(tool('file_write'), { replace: true });
    expect(bus.getTool('file_write')?.definition.name).toBe('file_write');
    expect(bus.listForAgent('default')).toHaveLength(1);
  });
});
