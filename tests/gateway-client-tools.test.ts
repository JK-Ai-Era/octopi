/**
 * Client Tool Host（Gateway 侧）— pending / 路由 / resolve
 */

import { describe, it, expect } from 'vitest';
import { ClientToolRegistry, ClientStreamTransport } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/client-tools/index.js';
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

  it('emits client_tools.changed with session-level added/removed names', () => {
    const { host, events } = makeHost();
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [noteForm],
    });
    const reg = events.find((e) => e.type === 'client_tools.changed');
    expect(reg?.data.addedNames).toEqual(['note_form']);
    expect(reg?.data.toolNames).toEqual(['note_form']);
    expect(reg?.data.removedNames).toEqual([]);

    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-2',
      descriptors: [photoCapture],
    });
    const reg2 = events.filter((e) => e.type === 'client_tools.changed').at(-1);
    expect(reg2?.data.addedNames).toEqual(['photo_capture']);

    host.unregisterClientTools({ sessionId: 's1', clientInstanceId: 'web-1' });
    const unreg = events.filter((e) => e.type === 'client_tools.changed').at(-1);
    expect(unreg?.data.removedNames).toEqual(['note_form']);
    expect(unreg?.data.toolNames).toEqual(['photo_capture']);
  });

  it('does not emit client_tools.changed when re-registering same tools', () => {
    const { host, events } = makeHost();
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [noteForm],
    });
    const before = events.filter((e) => e.type === 'client_tools.changed').length;
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [noteForm],
    });
    const after = events.filter((e) => e.type === 'client_tools.changed').length;
    expect(after).toBe(before);
  });

  it('does not failover when original call is sensitive even if alt is public', async () => {
    const { host, registered } = makeHost();
    const sensitiveForm: ClientToolDescriptor = {
      name: 'note_form',
      description: 'sensitive variant',
      parameters: {
        title: { type: 'string', description: 't', required: true },
        purpose: { type: 'string', description: 'why', required: true },
      },
      interaction: 'device',
      device: { class: 'sensor', sensitivity: 'sensitive', consent: 'strict' },
      resultKinds: ['value'],
    };
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [sensitiveForm],
    });
    // 解析会钉 web-1（唯一 sensitive）
    const tool = registered.find((t) => t.definition.name === 'note_form')!;
    const p = tool.handler(
      { title: 'x', purpose: 'demo' },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    );
    await Promise.resolve();
    const call = host.listSessionCalls('s1')[0]!;
    expect(call.sensitivity).toBe('sensitive');

    // 同名 public 端加入后再掉线原端 —— 不得换到 public
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-2',
      descriptors: [noteForm],
    });
    host.unregisterClientTools({ sessionId: 's1', clientInstanceId: 'web-1' });
    const after = host.getCall(call.id)!;
    expect(after.state).toBe('failed');
    expect(after.outcome).toMatchObject({ status: 'error', reason: 'client_unavailable' });
    await expect(p).resolves.toMatchObject({ error: 'client_unavailable' });
  });

  it('stamps call.processing from descriptor and resolve may override', async () => {
    const { host, registered } = makeHost();
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [{ ...noteForm, name: 'ocr_local', processing: 'local' }],
    });
    const tool = registered.find((t) => t.definition.name === 'ocr_local')!;
    const p = tool.handler(
      { title: 'x' },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    );
    await Promise.resolve();
    const call = host.listSessionCalls('s1')[0]!;
    expect(call.processing).toBe('local');
    host.resolveCall(call.id, {
      status: 'ok',
      result: { kind: 'value', data: { text: 'ok' } },
      processing: 'local',
    });
    await p;
    expect(host.getCall(call.id)?.processing).toBe('local');
  });

  it('fails over pending non-sensitive call when target unregisters', async () => {
    const { host, registered, events } = makeHost();
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [noteForm],
    });
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-2',
      descriptors: [noteForm],
    });
    host.heartbeat({ sessionId: 's1', clientInstanceId: 'web-2', now: Date.now() + 1_000 });
    const tool = registered.find((t) => t.definition.name === 'note_form')!;
    const p = tool.handler(
      { title: 'x' },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    );
    await Promise.resolve();
    const call = host.listSessionCalls('s1')[0]!;
    expect(call.targetClientInstanceId).toBe('web-2');

    host.unregisterClientTools({ sessionId: 's1', clientInstanceId: 'web-2' });
    const after = host.getCall(call.id)!;
    expect(after.state).toBe('pending');
    expect(after.targetClientInstanceId).toBe('web-1');
    expect(
      events.some((e) => e.type === 'client_tool.pending' && e.data.reason === 'failover'),
    ).toBe(true);

    host.resolveCall(call.id, {
      status: 'ok',
      result: { kind: 'value', data: { ok: true } },
    });
    await p;
  });

  it('does not fail over sensitive tool when target unregisters', async () => {
    const { host, registered } = makeHost();
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'ios-1',
      descriptors: [photoCapture],
    });
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'ios-2',
      descriptors: [photoCapture],
    });
    // sensitive 多候选 invoke 直接失败；改为钉一家再测掉线
    host.unregisterClientTools({ sessionId: 's1', clientInstanceId: 'ios-2' });
    const tool = registered.find((t) => t.definition.name === 'photo_capture')!;
    const p = tool.handler(
      { purpose: 'scan' },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    );
    await Promise.resolve();
    const call = host.listSessionCalls('s1')[0]!;
    host.unregisterClientTools({ sessionId: 's1', clientInstanceId: 'ios-1' });
    const after = host.getCall(call.id)!;
    expect(after.state).toBe('failed');
    expect(after.outcome).toMatchObject({ status: 'error', reason: 'client_unavailable' });
    await expect(p).resolves.toMatchObject({ error: 'client_unavailable' });
  });

  it('installs stream domain tools when descriptor.stream is set', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const registry = new ClientToolRegistry();
    const transport = new ClientStreamTransport({
      emitEvent: (e) => events.push({ type: e.type, data: e.data }),
      defaultMaxDurationMs: 0,
      makeStreamId: () => 'cs_watch1',
    });
    const registered: CoreRegisteredTool[] = [];
    const host = new ClientToolHost({
      registry,
      streamTransport: transport,
      registerGlobalTool: (tool) => registered.push(tool),
      unregisterGlobalTool: () => {},
      syncAgentTools: () => {},
      emitSessionEvent: () => {},
    });
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [
        {
          name: 'page_metrics_watch',
          description: 'watch page metrics',
          parameters: {},
          interaction: 'silent',
          resultKinds: ['value'],
          stream: { direction: 'source', handleKey: 'watchId' },
        },
      ],
    });
    const tool = registered.find((t) => t.definition.name === 'page_metrics_watch')!;
    const out = (await tool.handler({}, { sessionId: 's1', agentId: 'a1', messages: [] })) as {
      kind: string;
      data: Record<string, unknown>;
    };
    expect(out.kind).toBe('value');
    expect(out.data.watchId).toBe('cs_watch1');
    expect(events.some((e) => e.type === 'client_stream.opened')).toBe(true);
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

  it('persists terminal call and keeps it in recent list', async () => {
    const registry = new ClientToolRegistry();
    const persisted: Array<{ id: string; state: string }> = [];
    const host = new ClientToolHost({
      registry,
      registerGlobalTool: () => {},
      unregisterGlobalTool: () => {},
      syncAgentTools: () => {},
      emitSessionEvent: () => {},
      persistCall: (call) => {
        persisted.push({ id: call.id, state: call.state });
      },
      makeCallId: () => 'ctc_persist1',
      defaultTimeoutMs: 5_000,
    });
    host.registerClientTools({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [noteForm],
    });
    const tool = host.createInvoker();
    const invokeP = tool(
      {
        name: 'note_form',
        args: { title: 't' },
        sessionId: 's1',
        agentId: 'a1',
        callId: 'ctc_persist1',
        ttlAt: Date.now() + 5_000,
      },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    );
    await Promise.resolve();
    host.resolveCall('ctc_persist1', {
      status: 'ok',
      result: { kind: 'value', data: { ok: true } },
    });
    await invokeP;
    expect(persisted).toEqual([{ id: 'ctc_persist1', state: 'succeeded' }]);
    const recent = host.listRecentTerminalCalls('s1');
    expect(recent).toHaveLength(1);
    expect(recent[0]!.id).toBe('ctc_persist1');
  });
});
