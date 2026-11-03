import { describe, expect, it } from 'vitest';
import { DefaultToolBus } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/tool-bus.js';
import { pluginToolToRegisteredTool, mountPluginTools } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/plugin-tool.js';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import type { ToolExecutionContext } from '@octopi-agent/core/types.js';
import type { PluginToolRecord } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/contribution-registry.js';

function record(name = 'acme_echo', handler?: PluginToolRecord['handler']): PluginToolRecord {
  return {
    pluginId: 'acme.search',
    definition: {
      name,
      description: 'Echo through a plugin',
      parameters: { text: { type: 'string', description: 'Text', required: true } },
      capabilities: ['egress'],
    },
    handler: handler ?? (async (args) => ({ echoed: args.text })),
    optional: false,
  };
}

function context(agentId = 'a'): ToolExecutionContext {
  return { sessionId: 's', agentId, messages: [] } as unknown as ToolExecutionContext;
}

describe('Plugin Tool mounting and authorization', () => {
  it('does not expose a mounted plugin Tool under empty allow; explicit name and wildcard opt in', async () => {
    const bus = new DefaultToolBus();
    const mounted = mountPluginTools([record()], 'a', { allow: ['acme_echo'] }, bus.registerForAgent.bind(bus));
    expect(mounted).toHaveLength(1);
    expect(bus.resolve('a')).toEqual([]);
    expect(bus.resolve('a', { allow: ['other'] })).toEqual([]);
    expect(bus.resolve('a', { allow: ['acme_echo'] })).toHaveLength(1);
    expect(bus.resolve('a', { allow: ['*'] })).toHaveLength(1);
    await expect(bus.execute('acme_echo', { text: 'x' }, context())).rejects.toThrow('not allowed');
    expect((await bus.execute('acme_echo', { text: 'x' }, context(), { allow: ['acme_echo'] }))).toEqual({ echoed: 'x' });
  });

  it('deny wins over explicit and wildcard allow at both projection and execution', async () => {
    const bus = new DefaultToolBus();
    bus.registerForAgent('a', pluginToolToRegisteredTool(record()));
    expect(bus.resolve('a', { allow: ['*'], deny: ['acme_echo'] })).toEqual([]);
    expect(bus.resolve('a', { allow: ['*'], deny: ['*'] })).toEqual([]);
    await expect(bus.execute('acme_echo', { text: 'x' }, context(), { allow: ['*'], deny: ['acme_echo'] })).rejects.toThrow('not allowed');
  });

  it('uses the current RunScope policy for direct ToolBus execution', async () => {
    const { withRunScope } = await import('@octopi-agent/engine/harness/run/run-scope.js');
    const { createUnconfiguredFileEffects, createUnconfiguredMemoryEffects } = await import('@octopi-agent/engine/harness/extension/execution-environment/undo-log.js');
    const runtime = (allow: string[]) => ({ sessionId: 's', agentId: 'a', messages: [], fileEffects: createUnconfiguredFileEffects(), memoryEffects: createUnconfiguredMemoryEffects(), agentToolPolicy: { allow } });
    const bus = new DefaultToolBus();
    bus.registerForAgent('a', pluginToolToRegisteredTool(record()));
    const allowed = await withRunScope({ sessionId: 's', agentId: 'a', runId: 'r', toolRuntime: runtime(['acme_echo']) }, (async function* () { yield bus.execute('acme_echo', { text: 'scoped' }, context()); })()).next();
    expect(allowed.value).toEqual({ echoed: 'scoped' });
    const denied = withRunScope({ sessionId: 's', agentId: 'a', runId: 'r', toolRuntime: runtime([]) }, (async function* () { yield bus.execute('acme_echo', { text: 'scoped' }, context()); })());
    await expect(denied.next()).rejects.toThrow('not allowed');
  });

  it('does not change builtin empty-allow behavior and rejects same-name shadowing', () => {
    const bus = new DefaultToolBus();
    const builtin = record('builtin_echo');
    builtin.definition.capabilities = ['fs-read'];
    bus.register({ definition: builtin.definition, handler: builtin.handler });
    expect(bus.resolve('a')).toHaveLength(1);
    expect(() => bus.registerForAgent('a', pluginToolToRegisteredTool(record('builtin_echo')))).toThrow('already registered');
  });

  it('preserves plugin identity and defaults fs-write to sequential', async () => {
    const write = record('acme_write');
    write.definition.capabilities = ['fs-write'];
    const { AgentBuilder } = await import('@octopi-agent/engine/harness/agent/builder.js');
    const built = await new AgentBuilder().model('mock/m').pluginTools([write]).build({ mode: 'core' });
    const tool = built.agent.context.tools?.find((candidate) => candidate.name === 'acme_write');
    expect(tool?.executionMode).toBe('sequential');
    expect(tool?.source).toEqual({ kind: 'plugin', origin: 'acme.search', trustLevel: 'third-party' });
  });

  it('rejects direct AgentTool execution when the RunScope policy does not opt in', async () => {
    const built = await new AgentBuilder().model('mock/m').pluginTools([record()]).build({ mode: 'core' });
    const tool = built.agent.context.tools?.find((candidate) => candidate.name === 'acme_echo');
    const result = await tool?.execute('c1', { text: 'x' });
    expect(result?.isError).toBe(true);
    expect(String(result?.content)).toContain('not allowed');
    expect(result?.source?.origin).toBe('acme.search');
  });
});
