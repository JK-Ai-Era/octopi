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

describe('DefaultToolBus.resolve — denyCapabilities 漏斗（M8）', () => {
  it('denyCapabilities 作用于 resolve/execute（此前只认 allow/deny 名）', async () => {
    const bus = new DefaultToolBus();
    bus.register(tool('exec_tool'));
    bus.register(tool('reader_tool'));
    // 无 denyCapabilities：名称闸正常
    expect(
      bus
        .resolve('default', { allow: ['*'] })
        .map((t) => t.definition.name)
        .sort(),
    ).toEqual(['exec_tool', 'reader_tool']);
    // 有 denyCapabilities：能力标签未知（resolveToolCapabilities→null）→ fail-closed 全拒
    expect(bus.resolve('default', { allow: ['*'], denyCapabilities: ['exec'] })).toHaveLength(0);
    // denyCapabilities 存在时 execute 同样拒绝
    await expect(
      bus.execute(
        'exec_tool',
        {},
        { agentId: 'default' } as never,
        { allow: ['*'], denyCapabilities: ['exec'] },
      ),
    ).rejects.toThrow(/not allowed/);
  });
});
