import { describe, expect, it } from 'vitest';
import { PluginConfigSchema } from '@octopi-agent/engine/config-schema/agent.js';

describe('Plugin entry config schema', () => {
  it('accepts the documented hooks timeout settings', () => {
    const parsed = PluginConfigSchema.parse({
      entries: {
        'acme.search': {
          enabled: true,
          config: { region: 'cn' },
          hooks: { timeoutMs: 5000, timeouts: { before_tool_call: 1000 } },
        },
      },
    });
    expect(parsed.entries?.['acme.search']?.hooks?.timeouts?.before_tool_call).toBe(1000);
    expect(parsed.entries?.['acme.search']?.hooks?.timeoutMs).toBe(5000);
  });

  it('rejects unknown entry knobs instead of silently ignoring them', () => {
    expect(() => PluginConfigSchema.parse({
      entries: { 'acme.search': { hooks: { abortOnTimeout: { before_tool_call: true } } } },
    })).toThrow();
    expect(() => PluginConfigSchema.parse({
      entries: { 'acme.search': { hooks: { timeouts: { before_tool_call: 0 } } } },
    })).toThrow();
    expect(() => PluginConfigSchema.parse({
      entries: { 'acme.search': { hooks: { timeouts: { not_a_hook: 1000 } } } },
    })).toThrow();
  });
});
