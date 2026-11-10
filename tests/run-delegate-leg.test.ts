/**
 * delegated-run（S1 收口，arch/service-topology.md §9.5）行为锚：
 * 委派子 run 的 RunRequest 映射（含 D3 天花板透传）与执行腿 handle
 * （get-or-mount / fail-loud / signal 透传）。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildDelegatedRunRequest,
  createDelegatedLegHandle,
} from '@octopi-agent/engine/harness/activation/delegated-run.js';
import type { RunRequest } from '@octopi-agent/engine/harness/activation/index.js';
import type { Message } from '@octopi-agent/core/types.js';

const input: Message = { role: 'user', content: 'do the thing', timestamp: 1 };
const baseConfig = {
  systemPrompt: 'child persona',
  agentId: 'child-1',
  sessionId: 'child-sess',
  rightsCeiling: { tools: ['read'] },
} as never as Parameters<typeof buildDelegatedRunRequest>[2];

describe('buildDelegatedRunRequest（纯映射）', () => {
  it('映射 trigger/actorType/messages，systemPrompt/rightsCeiling 透传（D3）', () => {
    const req = buildDelegatedRunRequest('child-sess', input, baseConfig);
    expect(req.requestId).toMatch(/^child-/);
    expect(req.agentId).toBe('child-1');
    expect(req.sessionId).toBe('child-sess');
    expect(req.messages).toEqual([input]);
    expect(req.actorType).toBe('agent');
    expect(req.triggers).toHaveLength(1);
    expect(req.triggers[0]).toMatchObject({
      type: 'message',
      agentId: 'child-1',
      sessionId: 'child-sess',
      payload: { kind: 'user_message', content: 'do the thing' },
    });
    expect(req.systemPrompt).toBe('child persona');
    expect(req.rightsCeiling).toEqual({ tools: ['read'] });
  });

  it('model/modelProvider 映射 modelOverride/modelProvider；缺省字段省略', () => {
    const withModel = buildDelegatedRunRequest('child-sess', input, {
      ...baseConfig,
      model: 'fast',
      modelProvider: 'p1',
    } as never);
    expect(withModel.modelOverride).toBe('fast');
    expect(withModel.modelProvider).toBe('p1');
    const bare = buildDelegatedRunRequest('child-sess', input, {
      agentId: 'child-1',
      systemPrompt: 's',
    } as never);
    expect('modelOverride' in bare).toBe(false);
    expect('rightsCeiling' in bare).toBe(false);
  });

  it('缺 agentId fail-loud（假成功禁止）', () => {
    expect(() => buildDelegatedRunRequest('s', input, { systemPrompt: 's' } as never)).toThrow(
      /requires runConfig\.agentId/,
    );
  });
});

describe('createDelegatedLegHandle（执行腿）', () => {
  const startRun = vi.fn((req: RunRequest) =>
    (async function* (): AsyncGenerator<unknown> {
      yield { type: 'step.end', data: { content: JSON.stringify(req.requestId) } };
    })(),
  );

  it('未挂载即 get-or-mount 后经 startRun（/runs 同语义）；signal 透传', async () => {
    const ensureMounted = vi.fn(async () => undefined);
    const get = vi.fn(() => undefined);
    const getDefinition = vi.fn(() => ({ id: 'child-1' }));
    const handle = createDelegatedLegHandle({
      get,
      ensureMounted: ensureMounted as never,
      startRun: startRun as never,
      getDefinition: getDefinition as never,
    });
    const ctrl = new AbortController();
    const events = [];
    for await (const e of handle('child-sess', input, baseConfig, ctrl.signal)) {
      events.push(e);
    }
    expect(get).toHaveBeenCalledWith('child-1');
    expect(ensureMounted).toHaveBeenCalledWith('child-1', { id: 'child-1' });
    expect(startRun).toHaveBeenCalledTimes(1);
    const [req, signal] = startRun.mock.calls[0] as unknown as [RunRequest, AbortSignal];
    expect(req.agentId).toBe('child-1');
    expect(signal).toBe(ctrl.signal);
    expect(events).toHaveLength(1);
  });

  it('已挂载不再 ensureMounted', async () => {
    const ensureMounted = vi.fn(async () => undefined);
    const handle = createDelegatedLegHandle({
      get: () => ({ mounted: true }),
      ensureMounted: ensureMounted as never,
      startRun: startRun as never,
      getDefinition: () => ({ id: 'child-1' }),
    });
    for await (const _ of handle('child-sess', input, baseConfig)) {
      // 消费完
    }
    expect(ensureMounted).not.toHaveBeenCalled();
  });

  it('缺定义 fail-loud：delegate target not runnable', async () => {
    const handle = createDelegatedLegHandle({
      get: () => undefined,
      ensureMounted: vi.fn(async () => undefined) as never,
      startRun: startRun as never,
      getDefinition: () => undefined,
    });
    await expect(
      (async () => {
        for await (const _ of handle('child-sess', input, baseConfig)) {
          // 不应到达
        }
      })(),
    ).rejects.toThrow(/delegate target not runnable/);
  });
});
