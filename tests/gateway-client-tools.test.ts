/**
 * Client Tool Host（Gateway 侧）— pending / 路由 / resolve
 */

import { describe, it, expect } from 'vitest';
import { ClientToolRegistry } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/client-tools/index.js';
import type {
  ClientToolDescriptor,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/client-tools/index.js';
import type { RegisteredTool as CoreRegisteredTool } from '@octopi-agent/core/types/tools.js';
import { ClientToolHost } from '@octopi-agent/gateway/gateway/client-tools-host.js';

const noteForm: ClientToolDescriptor = {
  name: 'note_form',
  description: 'Form on client returns value.',
  parameters: { title: { type: 'string', description: 'title', required: true } },
  interaction: 'ui',
  resultKinds: ['value'],
};

const photoCapture: ClientToolDescriptor = {
  name: 'photo_capture',
  description: 'Capture photo asset.',
  parameters: { purpose: { type: 'string', description: 'purpose', required: true } },
  interaction: 'device',
  device: { class: 'sensor', sensitivity: 'sensitive', consent: 'strict' },
  resultKinds: ['asset'],
};

function makeHost() {
  const registry = new ClientToolRegistry();
  const registered: CoreRegisteredTool[] = [];
  const unregistered: string[] = [];
  const agentOps: unknown[] = [];
  const events: Array<{ sessionId: string; type: string; data: Record<string, unknown> }> = [];

  const host = new ClientToolHost({
    registry,
    registerGlobalTool: (tool) => {
      registered.push(tool);
    },
    unregisterGlobalTool: (name) => {
      unregistered.push(name);
    },
    syncAgentTools: (ops) => {
      agentOps.push(ops);
    },
    emitSessionEvent: (sessionId, event) => {
      events.push({ sessionId, type: event.type, data: event.data });
    },
    makeCallId: () => 'ctc_test1',
    defaultTimeoutMs: 5_000,
  });

  return { host, registry, registered, unregistered, agentOps, events };
}

describe('ClientToolHost', () => {
  it('installs tools on register and removes when last provider leaves', () => {
    const { host, registered, unregistered, agentOps } = makeHost();
    const r1 = host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [noteForm],
    });
    expect(r1.toolNames).toEqual(['note_form']);
    expect(registered.map((t) => t.definition.name)).toEqual(['note_form']);
    expect(agentOps.length).toBe(1);

    const r2 = host.unregisterClientTools({ sessionId: 's1', clientInstanceId: 'web-1' });
    expect(r2.removedNames).toEqual(['note_form']);
    expect(unregistered).toEqual(['note_form']);
    expect(agentOps.length).toBe(2);
  });

  it('invoke routes to client and resolve completes waiter', async () => {
    const { host, registered, events } = makeHost();
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [noteForm],
    });

    const tool = registered[0]!;
    const invokePromise = tool.handler(
      { title: 'hello' },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    );

    // pending 事件已广播
    await Promise.resolve();
    expect(events.some((e) => e.type === 'client_tool.pending')).toBe(true);

    const calls = host.listSessionCalls('s1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('note_form');
    expect(calls[0]!.targetClientInstanceId).toBe('web-1');

    const resolved = host.resolveCall(calls[0]!.id, {
      status: 'ok',
      result: { kind: 'value', data: { title: 'hello', body: 'x' } },
    }, 'user-1');
    expect(resolved?.state).toBe('succeeded');
    expect(resolved?.completedByPrincipalId).toBe('user-1');

    const out = (await invokePromise) as { kind: string; data: unknown };
    expect(out.kind).toBe('value');
    expect(out.data).toEqual({ title: 'hello', body: 'x' });
    expect(events.some((e) => e.type === 'client_tool.resolved')).toBe(true);
    expect(host.listSessionCalls('s1')).toHaveLength(0);
  });

  it('rejects sensitive tool when two clients provide it', async () => {
    const { host, registered } = makeHost();
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'a',
      descriptors: [photoCapture],
    });
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'b',
      descriptors: [photoCapture],
    });

    // 两个 provider 时不应 install 两次同名；handler 仍一个
    const tool = registered.find((t) => t.definition.name === 'photo_capture');
    expect(tool).toBeTruthy();
    const out = (await tool!.handler(
      { purpose: 'scan' },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    )) as { error: string; hint?: string };
    expect(out.error).toBe('unsupported');
    expect(out.hint).toMatch(/sensitive/);
  });

  it('cancelSessionCalls wakes pending with cancelled', async () => {
    const { host, registered } = makeHost();
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [noteForm],
    });
    const tool = registered[0]!;
    const p = tool.handler({ title: 't' }, { sessionId: 's1', agentId: 'a1', messages: [] });
    await Promise.resolve();
    host.cancelSessionCalls('s1');
    const out = (await p) as { error: string };
    expect(out.error).toBe('cancelled');
  });

  it('unregister while pending fails call with client_unavailable', async () => {
    const { host, registered } = makeHost();
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [noteForm],
    });
    const tool = registered[0]!;
    const p = tool.handler({ title: 't' }, { sessionId: 's1', agentId: 'a1', messages: [] });
    await Promise.resolve();
    host.unregisterClientTools({ sessionId: 's1', clientInstanceId: 'web-1' });
    const out = (await p) as { error: string };
    expect(out.error).toBe('client_unavailable');
  });

  it('keeps global tool installed while another session still provides it', () => {
    const { host, registered, unregistered } = makeHost();
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [noteForm],
    });
    host.registerClientTools({
      sessionId: 's2',
      clientInstanceId: 'web-2',
      descriptors: [noteForm],
    });
    expect(registered.filter((t) => t.definition.name === 'note_form')).toHaveLength(1);

    const r = host.unregisterClientTools({ sessionId: 's1', clientInstanceId: 'web-1' });
    expect(r.removedNames).toEqual([]);
    expect(unregistered).toEqual([]);

    const r2 = host.unregisterClientTools({ sessionId: 's2', clientInstanceId: 'web-2' });
    expect(r2.removedNames).toEqual(['note_form']);
    expect(unregistered).toEqual(['note_form']);
  });

  it('host abortSignal cancels pending call', async () => {
    const { host, registered } = makeHost();
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [noteForm],
    });
    const ac = new AbortController();
    const tool = registered[0]!;
    const p = tool.handler(
      { title: 't' },
      { sessionId: 's1', agentId: 'a1', messages: [], abortSignal: ac.signal },
    );
    await Promise.resolve();
    expect(host.listSessionCalls('s1')).toHaveLength(1);
    ac.abort();
    const out = (await p) as { error: string };
    expect(out.error).toBe('cancelled');
    expect(host.listSessionCalls('s1')).toHaveLength(0);
  });
});
