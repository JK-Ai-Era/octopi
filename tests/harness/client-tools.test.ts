import { describe, it, expect } from 'vitest';

import {
  createClientTool,
  ClientToolRegistry,
  validateClientToolDescriptor,
  validateClientToolOutcome,
  type ClientToolCallOutcome,
  type ClientToolDescriptor,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/client-tools/index.js';

const noteForm: ClientToolDescriptor = {
  name: 'note_form',
  description: 'Show a form and return the submitted fields as value.',
  parameters: {
    title: { type: 'string', description: 'Form title', required: true },
  },
  interaction: 'ui',
  resultKinds: ['value'],
};

const photoCapture: ClientToolDescriptor = {
  name: 'photo_capture',
  description: 'Take a photo and return an image asset.',
  parameters: {
    purpose: { type: 'string', description: 'Why the photo is needed', required: true },
  },
  interaction: 'device',
  device: { class: 'sensor', sensitivity: 'sensitive', consent: 'strict' },
  resultKinds: ['asset'],
};

describe('ClientToolRegistry', () => {
  it('lists names across clients and exposes last-active route', () => {
    let t = 1_000;
    const reg = new ClientToolRegistry({ clock: () => t });
    reg.registerClientProviders({
      sessionId: 's1',
      clientInstanceId: 'win-1',
      descriptors: [noteForm],
    });
    t = 2_000;
    reg.registerClientProviders({
      sessionId: 's1',
      clientInstanceId: 'ios-1',
      descriptors: [noteForm, photoCapture],
    });

    expect(reg.sessionToolNames('s1')).toEqual(['note_form', 'photo_capture']);
    const route = reg.resolveTarget('s1', 'note_form');
    expect(route.ok).toBe(true);
    if (route.ok) expect(route.clientInstanceId).toBe('ios-1');
  });

  it('rejects sensitive tool when multiple clients provide it', () => {
    let t = 1_000;
    const reg = new ClientToolRegistry({ clock: () => t });
    reg.registerClientProviders({
      sessionId: 's1',
      clientInstanceId: 'a',
      descriptors: [photoCapture],
    });
    t = 1_100;
    reg.registerClientProviders({
      sessionId: 's1',
      clientInstanceId: 'b',
      descriptors: [photoCapture],
    });
    const route = reg.resolveTarget('s1', 'photo_capture');
    expect(route.ok).toBe(false);
    if (!route.ok) expect(route.reason).toBe('ambiguous');
  });

  it('routes sensitive tool when only one provider', () => {
    const reg = new ClientToolRegistry({ clock: () => 1_000 });
    reg.registerClientProviders({
      sessionId: 's1',
      clientInstanceId: 'ios-1',
      descriptors: [photoCapture],
    });
    const route = reg.resolveTarget('s1', 'photo_capture');
    expect(route.ok).toBe(true);
    if (route.ok) expect(route.clientInstanceId).toBe('ios-1');
  });

  it('returns removed names when last provider unregisters', () => {
    const reg = new ClientToolRegistry({ clock: () => 1_000 });
    reg.registerClientProviders({
      sessionId: 's1',
      clientInstanceId: 'a',
      descriptors: [noteForm],
    });
    reg.registerClientProviders({
      sessionId: 's1',
      clientInstanceId: 'b',
      descriptors: [noteForm],
    });
    expect(reg.unregisterClientProviders({ sessionId: 's1', clientInstanceId: 'a' }).removedNames).toEqual([]);
    expect(reg.unregisterClientProviders({ sessionId: 's1', clientInstanceId: 'b' }).removedNames).toEqual([
      'note_form',
    ]);
  });

  it('reports unsupported when no provider', () => {
    const reg = new ClientToolRegistry();
    const route = reg.resolveTarget('s1', 'note_form');
    expect(route.ok).toBe(false);
    if (!route.ok) expect(route.reason).toBe('unsupported');
  });

  it('expires stale providers and drops their tools from the session face', () => {
    let t = 0;
    const reg = new ClientToolRegistry({ liveTtlMs: 1000, clock: () => t });
    reg.registerClientProviders({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [noteForm],
    });
    t = 500;
    expect(reg.hasLiveProvider('s1', 'note_form')).toBe(true);
    t = 2000;
    expect(reg.hasLiveProvider('s1', 'note_form')).toBe(false);
    expect(reg.sessionToolNames('s1')).toEqual([]);
    const route = reg.resolveTarget('s1', 'note_form');
    expect(route.ok).toBe(false);
    if (!route.ok) expect(route.reason).toBe('unsupported');
  });

  it('touchClient keeps provider live', () => {
    let t = 0;
    const reg = new ClientToolRegistry({ liveTtlMs: 1000, clock: () => t });
    reg.registerClientProviders({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      descriptors: [noteForm],
    });
    t = 900;
    reg.touchClient('s1', 'web-1');
    t = 1500;
    expect(reg.hasLiveProvider('s1', 'note_form')).toBe(true);
    t = 2500;
    expect(reg.hasLiveProvider('s1', 'note_form')).toBe(false);
  });
});

describe('createClientTool', () => {
  const ctx = { sessionId: 's1', agentId: 'a1', messages: [] };

  it('returns value result from invoker', async () => {
    const tool = createClientTool(noteForm, async () => ({
      status: 'ok',
      result: { kind: 'value', data: { title: 'hi', body: 'x' } },
    }));
    const out = (await tool.handler({ title: 'hi' }, ctx)) as {
      kind: string;
      data: unknown;
    };
    expect(out.kind).toBe('value');
    expect(out.data).toEqual({ title: 'hi', body: 'x' });
  });

  it('returns asset result shape from invoker', async () => {
    const tool = createClientTool(photoCapture, async () => ({
      status: 'ok',
      result: {
        kind: 'asset',
        assetId: 'att_1',
        mime: 'image/jpeg',
        sizeBytes: 12,
      },
    }));
    const out = (await tool.handler({ purpose: 'scan' }, ctx)) as {
      kind: string;
      assetId: string;
      mime: string;
      sizeBytes: number;
    };
    expect(out.kind).toBe('asset');
    expect(out.assetId).toBe('att_1');
    expect(out.mime).toBe('image/jpeg');
    expect(out.sizeBytes).toBe(12);
  });

  it('maps error outcomes to explicit error payload (no fake success)', async () => {
    const tool = createClientTool(photoCapture, async () => ({
      status: 'error',
      reason: 'consent_denied',
      hint: 'user denied camera',
    }));
    const out = (await tool.handler({ purpose: 'scan' }, ctx)) as {
      error: string;
      hint?: string;
    };
    expect(out.error).toBe('consent_denied');
    expect(out.hint).toBe('user denied camera');
  });

  it('times out to expired when invoker never settles', async () => {
    const tool = createClientTool(
      noteForm,
      () => new Promise<ClientToolCallOutcome>(() => {}),
      { timeoutMs: 20 },
    );
    const out = (await tool.handler({ title: 't' }, ctx)) as { error: string };
    expect(out.error).toBe('expired');
  });

  it('aborts to cancelled when signal aborts', async () => {
    const ac = new AbortController();
    const tool = createClientTool(
      noteForm,
      () => new Promise<ClientToolCallOutcome>(() => {}),
      { timeoutMs: 5000 },
    );
    const p = tool.handler({ title: 't' }, { ...ctx, abortSignal: ac.signal });
    ac.abort();
    const out = (await p) as { error: string };
    expect(out.error).toBe('cancelled');
  });

  it('rejects invalid_arguments when required field missing', async () => {
    const tool = createClientTool(noteForm, async () => ({
      status: 'ok',
      result: { kind: 'value', data: {} },
    }));
    const out = (await tool.handler({}, ctx)) as { error: string; hint?: string };
    expect(out.error).toBe('invalid_arguments');
    expect(out.hint).toMatch(/title/);
  });

  it('rejects device tool without purpose', async () => {
    const tool = createClientTool(photoCapture, async () => ({
      status: 'ok',
      result: { kind: 'asset', assetId: 'a', mime: 'image/jpeg', sizeBytes: 1 },
    }));
    const out = (await tool.handler({}, ctx)) as { error: string; hint?: string };
    expect(out.error).toBe('invalid_arguments');
    expect(out.hint).toMatch(/purpose/);
  });
});

describe('processing validation', () => {
  it('accepts descriptor processing local|server and rejects other', () => {
    expect(
      validateClientToolDescriptor({
        name: 'ocr_local',
        description: 'local ocr',
        parameters: {},
        processing: 'local',
      }),
    ).toBeNull();
    expect(
      validateClientToolDescriptor({
        name: 'ocr_bad',
        description: 'bad',
        parameters: {},
        processing: 'cloud',
      }),
    ).toMatch(/processing/);
  });

  it('rejects outcome with unknown processing', () => {
    expect(
      validateClientToolOutcome({
        status: 'ok',
        processing: 'edge',
        result: { kind: 'value', data: 1 },
      }),
    ).toMatch(/processing/);
    expect(
      validateClientToolOutcome({
        status: 'ok',
        processing: 'local',
        result: { kind: 'value', data: 1 },
      }),
    ).toBeNull();
  });
});

describe('multi-client routing', () => {
  it('filters candidates by clientFilter.platforms and instanceId', () => {
    const reg = new ClientToolRegistry();
    reg.registerClientProviders({
      sessionId: 's1',
      clientInstanceId: 'ios-1',
      platform: 'ios',
      descriptors: [
        {
          name: 'photo_capture',
          description: 'photo',
          parameters: {},
          clientFilter: { platforms: ['ios'] },
        },
      ],
    });
    reg.registerClientProviders({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      platform: 'web',
      descriptors: [
        {
          name: 'photo_capture',
          description: 'photo',
          parameters: {},
          clientFilter: { platforms: ['ios'] },
        },
      ],
    });
    const route = reg.resolveTarget('s1', 'photo_capture');
    expect(route.ok).toBe(true);
    if (route.ok) expect(route.clientInstanceId).toBe('ios-1');
  });

  it('prefers sticky instance after notePreferred', () => {
    const reg = new ClientToolRegistry({ clock: () => 1_000 });
    reg.registerClientProviders({
      sessionId: 's1',
      clientInstanceId: 'web-1',
      platform: 'web',
      descriptors: [noteForm],
      now: 1_000,
    });
    reg.registerClientProviders({
      sessionId: 's1',
      clientInstanceId: 'web-2',
      platform: 'web',
      descriptors: [noteForm],
      now: 2_000,
    });
    // 最近活跃应为 web-2
    let route = reg.resolveTarget('s1', 'note_form', 3_000);
    expect(route.ok && route.clientInstanceId).toBe('web-2');
    reg.notePreferred('s1', 'note_form', 'web-1');
    route = reg.resolveTarget('s1', 'note_form', 3_000);
    expect(route.ok && route.clientInstanceId).toBe('web-1');
  });
});
