import { describe, it, expect, vi } from 'vitest';
import {
  ClientStreamTransport,
  createSinkStreamTool,
  createSourceStreamTool,
  createStreamStopTool,
  type ClientStreamEvent,
  type ClientToolDescriptor,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/client-tools/index.js';

function makeTransport(options?: {
  throttleMs?: number;
  maxBatch?: number;
  defaultMaxDurationMs?: number;
  ids?: string[];
}) {
  const events: ClientStreamEvent[] = [];
  let i = 0;
  const ids = options?.ids;
  const transport = new ClientStreamTransport({
    emitEvent: (e) => events.push(e),
    throttleMs: options?.throttleMs ?? 20,
    maxBatch: options?.maxBatch ?? 4,
    defaultMaxDurationMs: options?.defaultMaxDurationMs ?? 0,
    makeStreamId: () => (ids ? (ids[i++] ?? `cs_fallback_${i}`) : `cs_${++i}`),
  });
  return { transport, events };
}

describe('ClientStreamTransport', () => {
  it('opens source channel and emits client_stream.opened', () => {
    const { transport, events } = makeTransport({ ids: ['cs_1'] });
    const ch = transport.open({
      direction: 'source',
      sessionId: 's1',
      clientInstanceId: 'web-1',
      toolName: 'location_watch',
      toolCallId: 'ctc_1',
      sampleHint: 'geo/1hz',
    });
    expect(ch.streamId).toBe('cs_1');
    expect(ch.status).toBe('open');
    expect(events[0]?.type).toBe('client_stream.opened');
  });

  it('throttles samples into batches', async () => {
    vi.useFakeTimers();
    const { transport, events } = makeTransport({ throttleMs: 50, maxBatch: 10, ids: ['cs_1'] });
    transport.open({ direction: 'source', sessionId: 's1', clientInstanceId: 'web-1' });
    transport.writeSamples('cs_1', [{ data: 1 }, { data: 2 }]);
    transport.writeSamples('cs_1', [{ data: 3 }]);
    expect(events.filter((e) => e.type === 'client_stream.sample')).toHaveLength(0);
    vi.advanceTimersByTime(50);
    const samples = events.filter((e) => e.type === 'client_stream.sample');
    expect(samples).toHaveLength(1);
    expect((samples[0]!.data.samples as unknown[]).length).toBe(3);
    vi.useRealTimers();
  });

  it('drops overflow samples and reports dropped count', async () => {
    vi.useFakeTimers();
    const { transport, events } = makeTransport({ throttleMs: 10, maxBatch: 2, ids: ['cs_1'] });
    transport.open({ direction: 'sink', sessionId: 's1', clientInstanceId: 'web-1' });
    transport.writeSamples('cs_1', [{ data: 'a' }, { data: 'b' }, { data: 'c' }, { data: 'd' }]);
    vi.advanceTimersByTime(10);
    const dropped = events.filter((e) => e.type === 'client_stream.sample' && (e.data.dropped as number) > 0);
    expect(dropped.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('closes on TTL and emits client_stream.closed', async () => {
    vi.useFakeTimers();
    const { transport, events } = makeTransport({ defaultMaxDurationMs: 100, ids: ['cs_1'] });
    transport.open({ direction: 'source', sessionId: 's1', clientInstanceId: 'web-1' });
    vi.advanceTimersByTime(100);
    expect(transport.get('cs_1')).toBeUndefined();
    const closed = events.find((e) => e.type === 'client_stream.closed');
    expect(closed?.data.reason).toBe('ttl');
    vi.useRealTimers();
  });

  it('closeWhere closes session channels on client loss', () => {
    const { transport } = makeTransport({ ids: ['cs_1', 'cs_2'] });
    transport.open({ direction: 'source', sessionId: 's1', clientInstanceId: 'web-1' });
    transport.open({ direction: 'source', sessionId: 's1', clientInstanceId: 'web-2' });
    const n = transport.closeWhere(
      (c) => c.owner.sessionId === 's1' && c.owner.clientInstanceId === 'web-1',
      'client_unavailable',
    );
    expect(n).toBe(1);
    expect(transport.list('s1').map((c) => c.streamId)).toEqual(['cs_2']);
  });
});

describe('stream domain tools', () => {
  const watchDescriptor: ClientToolDescriptor = {
    name: 'location_watch',
    description: 'Watch device location samples via host stream channel.',
    parameters: { purpose: { type: 'string', description: 'why', required: true } },
    interaction: 'device',
    device: { class: 'sensor', sensitivity: 'personal', consent: 'prompt' },
    resultKinds: ['value'],
  };

  it('source tool returns watchId value handle (not generic stream API)', async () => {
    const { transport } = makeTransport({ ids: ['cs_watch'] });
    const tool = createSourceStreamTool(watchDescriptor, {
      transport,
      openChannel: ({ context }) => ({
        sessionId: context?.sessionId ?? 's1',
        clientInstanceId: 'phone-1',
        sampleHint: 'geo/1hz',
        toolCallId: 'ctc_w1',
        maxDurationMs: 60_000,
      }),
    });
    const out = (await tool.handler(
      { purpose: 'navigation' },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    )) as { kind: string; data: Record<string, unknown> };
    expect(out.kind).toBe('value');
    expect(out.data.watchId).toBe('cs_watch');
    expect(out.data.direction).toBe('source');
    expect(transport.get('cs_watch')?.status).toBe('open');
  });

  it('sink tool returns playId value handle', async () => {
    const { transport } = makeTransport({ ids: ['cs_play'] });
    const tool = createSinkStreamTool(
      {
        name: 'voice_play_live',
        description: 'Open sink channel for live audio playback.',
        parameters: {},
        interaction: 'silent',
        resultKinds: ['value'],
      },
      {
        transport,
        openChannel: ({ context }) => ({
          sessionId: context?.sessionId ?? 's1',
          clientInstanceId: 'web-1',
          sampleHint: 'audio/16k',
        }),
      },
    );
    const out = (await tool.handler({}, { sessionId: 's1', agentId: 'a1', messages: [] })) as {
      kind: string;
      data: Record<string, unknown>;
    };
    expect(out.data.playId).toBe('cs_play');
    expect(out.data.direction).toBe('sink');
  });

  it('sink tool reuses open channel and appends pulses (same playId)', async () => {
    const { transport, events } = makeTransport({ ids: ['cs_m1', 'cs_m2'], throttleMs: 5 });
    const tool = createSinkStreamTool(
      {
        name: 'sample_pulse_sink',
        description: 'meter',
        parameters: {
          playId: { type: 'string', description: 'reuse' },
          samples: { type: 'array', description: 'samples' },
        },
        interaction: 'silent',
        resultKinds: ['value'],
        stream: { direction: 'sink', handleKey: 'playId' },
      },
      {
        transport,
        openChannel: ({ context }) => ({
          sessionId: context?.sessionId ?? 's1',
          clientInstanceId: 'web-1',
        }),
      },
    );
    const ctx = { sessionId: 's1', agentId: 'a1', messages: [] };
    const first = (await tool.handler({ samples: [0.1, 0.2] }, ctx)) as {
      data: Record<string, unknown>;
    };
    expect(first.data.playId).toBe('cs_m1');
    expect(first.data.reused).toBe(false);

    const second = (await tool.handler({ playId: 'cs_m1', samples: [0.9] }, ctx)) as {
      data: Record<string, unknown>;
    };
    expect(second.data.playId).toBe('cs_m1');
    expect(second.data.reused).toBe(true);

    const third = (await tool.handler({ samples: [0.5] }, ctx)) as {
      data: Record<string, unknown>;
    };
    expect(third.data.playId).toBe('cs_m1');
    expect(third.data.reused).toBe(true);
    // 未新开第二条 sink
    expect(transport.list('s1')).toHaveLength(1);
    expect(events.some((e) => e.type === 'client_stream.opened')).toBe(true);
  });

  it('source tool sticky-reuses open watch', async () => {
    const { transport } = makeTransport({ ids: ['cs_w1', 'cs_w2'] });
    const tool = createSourceStreamTool(
      {
        name: 'page_metrics_watch',
        description: 'watch',
        parameters: {},
        interaction: 'silent',
        resultKinds: ['value'],
        stream: { direction: 'source', handleKey: 'watchId' },
      },
      {
        transport,
        openChannel: ({ context }) => ({
          sessionId: context?.sessionId ?? 's1',
          clientInstanceId: 'web-1',
        }),
      },
    );
    const ctx = { sessionId: 's1', agentId: 'a1', messages: [] };
    const a = (await tool.handler({}, ctx)) as { data: Record<string, unknown> };
    const b = (await tool.handler({}, ctx)) as { data: Record<string, unknown> };
    expect(a.data.watchId).toBe('cs_w1');
    expect(b.data.watchId).toBe('cs_w1');
    expect(b.data.reused).toBe(true);
    expect(transport.list('s1')).toHaveLength(1);
  });

  it('rejects cross-session stream handle reuse and stop', async () => {
    const { transport } = makeTransport({ ids: ['cs_x1', 'cs_x2'] });
    const tool = createSinkStreamTool(
      {
        name: 'sample_pulse_sink',
        description: 'sink',
        parameters: {
          playId: { type: 'string', description: 'reuse' },
          samples: { type: 'array', description: 'samples' },
        },
        interaction: 'silent',
        resultKinds: ['value'],
        stream: { direction: 'sink', handleKey: 'playId' },
      },
      {
        transport,
        openChannel: ({ context }) => ({
          sessionId: context?.sessionId ?? 's1',
          clientInstanceId: 'web-1',
        }),
      },
    );
    const open = (await tool.handler(
      { samples: [0.2] },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    )) as { data: Record<string, unknown> };
    const playId = String(open.data.playId);
    const cross = (await tool.handler(
      { playId, samples: [0.9] },
      { sessionId: 's2', agentId: 'a2', messages: [] },
    )) as { error?: string };
    expect(cross.error).toBe('permission_denied');

    const stop = createStreamStopTool(
      {
        name: 'sample_pulse_stop',
        description: 'stop',
        parameters: { playId: { type: 'string', description: 'id', required: true } },
        interaction: 'silent',
        resultKinds: ['value'],
        stream: { direction: 'stop', handleKey: 'playId' },
      },
      { transport, handleKey: 'playId' },
    );
    const denied = (await stop.handler(
      { playId },
      { sessionId: 's2', agentId: 'a2', messages: [] },
    )) as { error?: string };
    expect(denied.error).toBe('permission_denied');
    expect(transport.get(playId)?.status).toBe('open');
  });
});
