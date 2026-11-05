import { describe, expect, it } from 'vitest';
import { PluginHookAdapter, type RegisteredHook } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/hooks/adapter.js';
import type { HookAuditRecord, HookToolEvent } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/hooks/types.js';
import type { HitlOutcome } from '@octopi-agent/engine/harness/governance/human-in-the-loop/decision-cache.js';
import type { Message, ToolCall } from '@octopi-agent/core/types.js';

const records: HookAuditRecord[] = [];
const base = { sessionId: 's', agentId: 'a', runId: 'r' };
const call: ToolCall = { id: 'call-1', name: 'echo', arguments: { value: 'raw' } };

function adapter(hooks: RegisteredHook[], approve?: (request: unknown) => Promise<HitlOutcome>): PluginHookAdapter {
  return new PluginHookAdapter({
    getHooks: () => hooks,
    getPluginConfig: () => undefined,
    recordHook: (record) => { records.push(record); },
    approveToolCall: async (_event, request) => approve?.(request) ?? {
      allowed: false, decision: 'deny', timedOut: false, denyReason: 'no_channel', denyDetail: 'no approval channel',
    },
  });
}

function hook(pluginId: string, hookName: RegisteredHook['hookName'], handler: (event: never) => unknown, phase: RegisteredHook['phase'] = 'single', priority = 0): RegisteredHook {
  return { pluginId, hookName, handler, phase, priority };
}

describe('P4 Hook cardinality and failure semantics', () => {
  it('collects every contribution and fails open only for optional data', async () => {
    records.length = 0;
    const port = adapter([
      hook('a', 'before_prompt_build', () => 'first'),
      hook('b', 'before_prompt_build', () => { throw new Error('broken collector'); }),
      hook('c', 'before_prompt_build', () => ({ text: 'third' })),
    ]);
    const result = await port.collect('before_prompt_build', { ...base, prompt: 'question', messages: [] });
    expect(result.contributions.map((item) => [item.pluginId, item.value.text])).toEqual([['a', 'first'], ['c', 'third']]);
    expect(records.find((record) => record.pluginId === 'b')?.outcome).toBe('error');
  });

  it('feeds each Transform the previous output and does not publish partial output on failure', async () => {
    const seen: string[] = [];
    const port = adapter([
      hook('a', 'agent_turn_prepare', (event) => { seen.push((event as { prompt: string }).prompt); return 'first'; }, 'single', 10),
      hook('b', 'agent_turn_prepare', (event) => { seen.push((event as { prompt: string }).prompt); return 'second'; }),
    ]);
    expect((await port.transform('agent_turn_prepare', { ...base, prompt: 'raw', messages: [] }, 'raw')).value).toBe('second');
    expect(seen).toEqual(['raw', 'first']);
    const failing = adapter([
      hook('a', 'agent_turn_prepare', () => 'changed'),
      hook('b', 'agent_turn_prepare', () => { throw new Error('no partial transform'); }),
    ]);
    await expect(failing.transform('agent_turn_prepare', { ...base, prompt: 'raw', messages: [] }, 'raw')).rejects.toThrow('no partial transform');
  });

  it('runs all Votes, lets deny win, and never treats priority allow as a veto', async () => {
    const called: string[] = [];
    const port = adapter([
      hook('allow', 'before_agent_run', () => { called.push('allow'); return { decision: 'allow' }; }, 'single', 100),
      hook('deny', 'before_agent_run', () => { called.push('deny'); return { decision: 'deny', reason: 'no' }; }),
      hook('last', 'before_agent_run', () => { called.push('last'); }),
    ]);
    expect(await port.vote('before_agent_run', { ...base, prompt: '', messages: [] })).toMatchObject({ decision: 'deny', pluginId: 'deny' });
    expect(called).toEqual(['allow', 'deny', 'last']);
  });

  it('rejects multiple Override owners instead of choosing priority', async () => {
    const reply: Message = { role: 'assistant', content: 'override', timestamp: 1 };
    const port = adapter([
      hook('a', 'before_agent_reply', () => reply),
      hook('b', 'before_agent_reply', () => reply),
    ]);
    await expect(port.override('before_agent_reply', { ...base, prompt: '', messages: [] })).rejects.toThrow('multiple owners');
  });

  it('separates Tool Transform from Vote, audits raw/final params and skips approval on deny', async () => {
    let approvalCalls = 0;
    const port = adapter([
      hook('transform', 'before_tool_call', (event) => ({ ...(event as unknown as HookToolEvent).params, value: 'changed' }), 'transform'),
      hook('deny', 'before_tool_call', (event) => ({ decision: 'deny', reason: `final=${(event as unknown as HookToolEvent).params.value}` }), 'vote'),
      hook('approval', 'before_tool_call', () => ({ decision: 'require_approval', approval: { title: 'Approve', description: 'run tool' } }), 'vote'),
    ], async () => { approvalCalls++; return { allowed: true, decision: 'approve', timedOut: false }; });
    const event: HookToolEvent = { ...base, toolName: 'echo', call, params: { value: 'raw' } };
    const transformed = await port.transformBeforeToolCall(event);
    expect(transformed.value).toEqual({ value: 'changed' });
    expect(await port.voteBeforeToolCall({ ...event, params: transformed.value }, event.params)).toMatchObject({ decision: 'deny', reason: 'final=changed' });
    expect(approvalCalls).toBe(0);
    expect(records.filter((record) => record.hookName === 'before_tool_call').map((record) => record.phase)).toContain('vote');
  });

  it('fails closed for a Tool approval timeout and makes abort observable', async () => {
    const port = adapter([
      hook('slow', 'before_tool_call', async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { decision: 'allow' };
      }, 'vote', 0),
    ]);
    (port as unknown as { host: { getPluginConfig: () => { hooks: { timeoutMs: number } } } }).host.getPluginConfig = () => ({ hooks: { timeoutMs: 5 } });
    const event: HookToolEvent = { ...base, toolName: 'echo', call, params: {} };
    expect(await port.voteBeforeToolCall(event, event.params)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('timed out') });
    expect(records.at(-1)).toMatchObject({ outcome: 'timeout', phase: 'vote', pluginId: 'slow' });
  });

  it('resolves a granted Host approval to allow and records the real HITL decision', async () => {
    records.length = 0;
    const asks: unknown[] = [];
    const port = adapter([
      hook('ask', 'before_tool_call', () => ({
        decision: 'require_approval',
        approval: { title: 'Run echo', description: 'execute echo', severity: 'critical' },
      }), 'vote'),
    ], async (request) => {
      asks.push(request);
      return { allowed: true, decision: 'approve_session', timedOut: false };
    });
    const event: HookToolEvent = { ...base, toolName: 'echo', call, params: { value: 'raw' } };
    const vote = await port.voteBeforeToolCall(event, event.params);
    expect(vote.decision).toBe('allow');
    expect(asks).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({
      outcome: 'ok', phase: 'vote', details: { hitlDecision: 'approve_session' },
    });
  });

  it('keeps the real denial source when Host approval times out or is cancelled', async () => {
    const event: HookToolEvent = { ...base, toolName: 'echo', call, params: {} };
    const timeoutPort = adapter([
      hook('ask', 'before_tool_call', () => ({ decision: 'require_approval', approval: { title: 'A', description: 'd' } }), 'vote'),
    ], async () => ({ allowed: false, decision: 'deny', timedOut: true, denyDetail: 'Host approval was not granted: timeout' }));
    expect(await timeoutPort.voteBeforeToolCall(event, event.params)).toMatchObject({
      decision: 'deny', reason: 'Host approval was not granted: timeout',
    });
    const cancelPort = adapter([
      hook('ask', 'before_tool_call', () => ({ decision: 'require_approval', approval: { title: 'A', description: 'd' } }), 'vote'),
    ], async () => ({ allowed: false, decision: 'deny', timedOut: false, denyReason: 'cancelled', denyDetail: 'Host approval was not granted: cancelled' }));
    expect(await cancelPort.voteBeforeToolCall(event, event.params)).toMatchObject({
      decision: 'deny', reason: 'Host approval was not granted: cancelled',
    });
  });

  it('rejects Finalize and Reply values that would leave dangling toolCalls', async () => {
    const reply: Message = { role: 'assistant', content: 'raw', timestamp: 1 };
    const finalizePort = adapter([
      hook('bad', 'before_agent_finalize', () => ({ role: 'assistant', content: 'x', toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }] })),
    ]);
    await expect(
      finalizePort.transform('before_agent_finalize', { ...base, runId: 'r', reply }, reply),
    ).rejects.toThrow(/toolCalls/);
    const replyPort = adapter([
      hook('bad', 'before_agent_reply', () => ({ role: 'assistant', content: 'x', toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }] })),
    ]);
    await expect(replyPort.override('before_agent_reply', { ...base, runId: 'r', prompt: 'go', messages: [] })).rejects.toThrow(/toolCalls/);
  });
});
