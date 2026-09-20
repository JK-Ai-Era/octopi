/**
 * Observer 通道 — Run 现场快照与 Hub
 */

import { describe, expect, it } from 'vitest';
import {
  ObserverHub,
  resolveObserverConfig,
  shouldCaptureMessageFullText,
  summarizeMessages,
  summarizeLlmMessages,
  buildRunMessagesDiff,
  cloneMessages,
  isHiddenFromChat,
} from '../../src/harness/observer/index.js';
import type { Message } from '../../src/core/types.js';
import type { RunScope } from '../../src/harness/run-scope.js';

function msg(partial: Partial<Message> & Pick<Message, 'role'>): Message {
  return {
    content: '',
    timestamp: Date.now(),
    ...partial,
  } as Message;
}

describe('resolveObserverConfig (方案 A: level=预设, 显式覆盖)', () => {
  it('未配置 = level off：不采集、webPanel 关', () => {
    const cfg = resolveObserverConfig(undefined);
    expect(cfg.enabled).toBe(false);
    expect(cfg.level).toBe('off');
    expect(cfg.webPanel).toBe(false);
    expect(cfg.channels['run.scope']).toBe(false);
    expect(shouldCaptureMessageFullText(cfg)).toBe(false);
  });

  it('level=summary 预设：有通道、无 message 全文；webPanel 默认开', () => {
    const cfg = resolveObserverConfig({ level: 'summary' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.level).toBe('summary');
    expect(cfg.channels['run.scope']).toBe(true);
    expect(cfg.channels['context.llm']).toBe(false);
    expect(cfg.channels['tool.effect']).toBe(true);
    expect(cfg.channels.security).toBe(true);
    expect(cfg.channels.memory).toBe(true);
    expect(cfg.payload.messageFullText).toBe(false);
    expect(cfg.retention.messagesPerRun).toBe('summary-only');
    expect(cfg.webPanel).toBe(true);
    expect(shouldCaptureMessageFullText(cfg)).toBe(false);
  });

  it('level=full 预设允许全文与 context.llm', () => {
    const cfg = resolveObserverConfig({ level: 'full' });
    expect(cfg.payload.messageFullText).toBe(true);
    expect(cfg.retention.messagesPerRun).toBe('full');
    expect(cfg.channels['context.llm']).toBe(true);
    expect(shouldCaptureMessageFullText(cfg)).toBe(true);
  });

  it('level=off 时显式 webPanel=true 仍强制关面板', () => {
    const cfg = resolveObserverConfig({ level: 'off', webPanel: true });
    expect(cfg.enabled).toBe(false);
    expect(cfg.webPanel).toBe(false);
  });

  it('level=full + 显式 webPanel=false：采集开、面板关', () => {
    const cfg = resolveObserverConfig({ level: 'full', webPanel: false });
    expect(cfg.enabled).toBe(true);
    expect(cfg.webPanel).toBe(false);
  });

  it('level=full + 显式关 payload：不采全文', () => {
    const cfg = resolveObserverConfig({
      level: 'full',
      payload: { messageFullText: false },
    });
    expect(cfg.payload.messageFullText).toBe(false);
    expect(cfg.retention.messagesPerRun).toBe('full');
    expect(shouldCaptureMessageFullText(cfg)).toBe(false);
  });

  it('level=summary + 显式开全文两项：采全文', () => {
    const cfg = resolveObserverConfig({
      level: 'summary',
      payload: { messageFullText: true },
      retention: { messagesPerRun: 'full' },
    });
    expect(shouldCaptureMessageFullText(cfg)).toBe(true);
  });

  it('channel override wins over level preset', () => {
    const cfg = resolveObserverConfig({
      level: 'summary',
      channels: { 'run.messages': false, 'run.scope': true },
    });
    expect(cfg.channels['run.messages']).toBe(false);
    expect(cfg.channels['run.scope']).toBe(true);
  });

  it('enabled 由 level 推导：summary/full=on，off=off（无独立 enabled 字段）', () => {
    expect(resolveObserverConfig({ level: 'summary' }).enabled).toBe(true);
    expect(resolveObserverConfig({ level: 'full' }).enabled).toBe(true);
    expect(resolveObserverConfig({ level: 'off' }).enabled).toBe(false);
  });
});

describe('summarizeMessages', () => {
  it('counts roles and hidden systemPrompt', () => {
    const messages: Message[] = [
      msg({ role: 'system', content: 'You are agent', metadata: { source: 'systemPrompt' } }),
      msg({ role: 'user', content: 'hi' }),
      msg({ role: 'assistant', content: 'hello', agentId: 'a1' }),
      msg({ role: 'user', content: '[summary]', metadata: { source: 'contextSummary' } }),
    ];
    const { summary, views } = summarizeMessages(messages);
    expect(summary.count).toBe(4);
    expect(summary.systemPromptCount).toBe(1);
    expect(summary.contextSummaryCount).toBe(1);
    expect(summary.hiddenFromChatCount).toBeGreaterThanOrEqual(1);
    expect(summary.agentIds).toContain('a1');
    expect(views[0]?.hiddenFromChat).toBe(true);
    expect(views[1]?.hiddenFromChat).toBe(false);
  });

  it('isHiddenFromChat matches systemPrompt source', () => {
    expect(
      isHiddenFromChat({ role: 'system', content: 'x', metadata: { source: 'systemPrompt' } }),
    ).toBe(true);
    expect(isHiddenFromChat({ role: 'user', content: 'x' })).toBe(false);
  });

  it('cloneMessages deep copies tool args', () => {
    const messages: Message[] = [
      msg({
        role: 'assistant',
        content: 'call',
        toolCalls: [{ id: 't1', name: 'bash', arguments: { cmd: 'ls' } }],
      }),
    ];
    const cloned = cloneMessages(messages);
    expect(cloned[0]?.toolCalls?.[0]?.arguments).toEqual({ cmd: 'ls' });
    expect(cloned[0]?.toolCalls?.[0]?.arguments).not.toBe(
      messages[0]?.toolCalls?.[0]?.arguments,
    );
  });

  it('summarizeLlmMessages does not treat system as hiddenFromChat', () => {
    const s = summarizeLlmMessages([
      { role: 'system', content: 'x' },
      { role: 'user', content: 'yy' },
    ]);
    expect(s.systemPromptCount).toBe(1);
    expect(s.hiddenFromChatCount).toBe(0);
  });
});

describe('ObserverHub', () => {
  const scope: RunScope = {
    sessionId: 's1',
    agentId: 'agent1',
    systemPrompt: 'SYSTEM PROMPT BODY',
    agentRevision: 'rev-1',
    toolRuntime: {
      sessionId: 's1',
      agentId: 'agent1',
      messages: [],
      cwd: '/tmp/work',
      isolation: 'none',
    },
  };

  it('records run start/end and exposes observatory + messages', () => {
    const hub = new ObserverHub({ level: 'full', payload: { messageFullText: true } });
    const entry: Message[] = [
      msg({ role: 'system', content: 'sp', metadata: { source: 'systemPrompt' } }),
      msg({ role: 'user', content: 'hello world' }),
    ];
    const runId = hub.recordRunStart({
      scope,
      resolvedModel: { modelName: 'm1', providerId: 'openai', contextWindow: 128000 },
      messages: entry,
    });
    expect(runId).toBeTruthy();

    const obs = hub.getRunObservatory('s1');
    expect(obs?.runId).toBe(runId);
    expect(obs?.scope.agentRevision).toBe('rev-1');
    expect(obs?.scope.toolRuntime?.cwd).toBe('/tmp/work');
    expect(obs?.scope.resolvedModel?.modelName).toBe('m1');
    expect(obs?.messagesSummary?.count).toBe(2);

    const finalMessages: Message[] = [
      ...entry,
      msg({ role: 'assistant', content: 'reply', agentId: 'agent1' }),
    ];
    hub.recordRunEnd({
      runId,
      sessionId: 's1',
      messages: finalMessages,
      endReason: 'completed',
    });

    const msgs = hub.getRunMessages('s1', { phase: 'final' });
    expect(msgs?.summary.count).toBe(3);
    expect(msgs?.messages?.length).toBe(3);
    expect(msgs?.messages?.[2]?.content).toBe('reply');
  });

  it('summary preset omits full message bodies', () => {
    const hub = new ObserverHub({ level: 'summary' });
    const runId = hub.recordRunStart({
      scope,
      messages: [msg({ role: 'user', content: 'hi' })],
    });
    const msgs = hub.getRunMessages('s1', { runId, phase: 'entry' });
    expect(msgs?.summary.count).toBe(1);
    expect(msgs?.messages?.[0]?.content).toBeUndefined();
  });

  it('full preset captures message bodies without extra payload flags', () => {
    const hub = new ObserverHub({ level: 'full' });
    const runId = hub.recordRunStart({
      scope,
      messages: [msg({ role: 'user', content: 'full body here' })],
    });
    hub.recordRunEnd({
      runId,
      sessionId: 's1',
      messages: [msg({ role: 'user', content: 'full body here' })],
      endReason: 'completed',
    });
    const msgs = hub.getRunMessages('s1', { runId, phase: 'final' });
    expect(msgs?.messages?.[0]?.content).toBe('full body here');
  });

  it('ingestEvent builds timeline for active run', () => {
    const hub = new ObserverHub({ level: 'full' });
    const runId = hub.recordRunStart({ scope, messages: [] });
    hub.ingestEvent({
      type: 'engine.start',
      timestamp: Date.now(),
      sessionId: 's1',
      data: {},
    });
    hub.ingestEvent({
      type: 'tool.exec.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { toolName: 'bash', hasError: false, durationMs: 12 },
    });
    hub.ingestEvent({
      type: 'engine.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: { reason: 'completed' },
    });
    const obs = hub.getRunById(runId);
    expect(obs?.timeline?.length).toBe(3);
    expect(obs?.lifecycle?.toolCalls).toBe(1);
    expect(obs?.lifecycle?.endReason).toBe('completed');
  });

  it('disabled hub does not record', () => {
    const hub = new ObserverHub({ level: 'off' });
    expect(hub.isEnabled()).toBe(false);
    const runId = hub.recordRunStart({ scope, messages: [] });
    expect(runId).toBe('');
    expect(hub.getRunObservatory('s1')).toBeNull();
  });

  it('uses scope.runId when provided (Runner 对齐身份)', () => {
    const hub = new ObserverHub({ level: 'full' });
    const scoped: RunScope = { ...scope, runId: 'run_aligned_s1_agent1' };
    const runId = hub.recordRunStart({ scope: scoped, messages: [] });
    expect(runId).toBe('run_aligned_s1_agent1');
    expect(hub.getRunById(runId)?.scope.runId).toBe('run_aligned_s1_agent1');
  });

  it('run.scope.llm event does not wipe full LLM messages', () => {
    const hub = new ObserverHub({ level: 'full' });
    const runId = hub.recordRunStart({
      scope,
      messages: [msg({ role: 'user', content: 'hi' })],
    });
    hub.recordLlmMessages({
      sessionId: 's1',
      runId,
      messages: [
        { role: 'system', content: 'sp' },
        { role: 'user', content: 'hi' },
      ],
      estimatedTokens: 10,
    });
    hub.ingestEvent({
      type: 'run.scope.llm',
      timestamp: Date.now(),
      sessionId: 's1',
      data: {
        runId,
        summary: {
          count: 2,
          byRole: { system: 1, user: 1 },
          systemPromptCount: 1,
          contextSummaryCount: 0,
          hiddenFromChatCount: 0,
          chars: 4,
          agentIds: [],
        },
        estimatedTokens: 99,
      },
    });
    const llm = hub.getRunMessages('s1', { runId, view: 'llm' });
    expect(llm?.messages?.length).toBe(2);
    expect(llm?.messages?.[0]?.content).toBe('sp');
    expect(hub.getRunById(runId)?.llmEstimatedTokens).toBe(99);
  });

  it('recordRunEnd is idempotent and clears active run', () => {
    const hub = new ObserverHub({ level: 'full' });
    const runId = hub.recordRunStart({
      scope: { ...scope, runId: 'run_close_me' },
      messages: [msg({ role: 'user', content: 'hi' })],
    });
    hub.recordRunEnd({
      runId,
      sessionId: 's1',
      messages: [msg({ role: 'user', content: 'hi' }), msg({ role: 'assistant', content: 'ok' })],
      endReason: 'error',
      error: 'boom',
    });
    const obs = hub.getRunById(runId);
    expect(obs?.lifecycle?.endReason).toBe('error');
    expect(obs?.lifecycle?.error).toBe('boom');
    expect(obs?.lifecycle?.endedAt).toBeTruthy();
    // 二次 close 不应抛错
    hub.recordRunEnd({ runId, sessionId: 's1', endReason: 'error', error: 'boom' });
  });

  it('summary preset omits systemPrompt preview by default payload gates', () => {
    const hub = new ObserverHub({ level: 'summary' });
    const runId = hub.recordRunStart({
      scope: { ...scope, systemPrompt: 'X'.repeat(300) },
      messages: [],
    });
    const obs = hub.getRunById(runId);
    expect(obs?.scope.systemPromptChars).toBe(300);
    expect(obs?.scope.systemPromptPreview?.length).toBeGreaterThan(0);
  });

  it('payload.layerPreview=false strips systemPrompt preview', () => {
    const hub = new ObserverHub({
      level: 'full',
      payload: { layerPreview: false, layerContent: false },
    });
    const runId = hub.recordRunStart({
      scope: { ...scope, systemPrompt: 'Y'.repeat(300) },
      messages: [],
    });
    const obs = hub.getRunById(runId);
    expect(obs?.scope.systemPromptChars).toBe(300);
    expect(obs?.scope.systemPromptPreview).toBe('');
  });

  it('level=full captures systemPromptFull for preview/full toggle', () => {
    const hub = new ObserverHub({ level: 'full' });
    const body = 'FULL PROMPT BODY '.repeat(10);
    const runId = hub.recordRunStart({
      scope: { ...scope, systemPrompt: body },
      messages: [],
    });
    const obs = hub.getRunById(runId);
    expect(obs?.scope.systemPromptFull).toBe(body);
  });

  it('recordRunEnd backfills lifecycle turns/toolCalls from guard metrics', () => {
    const hub = new ObserverHub({ level: 'full' });
    const runId = hub.recordRunStart({
      scope: { ...scope, runId: 'run_backfill' },
      messages: [msg({ role: 'user', content: 'hi' })],
    });
    hub.ingestEvent({
      type: 'run.guard.metrics',
      timestamp: Date.now(),
      sessionId: 's1',
      data: {
        iteration: 2,
        totalToolCalls: 3,
        totalTokens: 175600,
        elapsedMs: 1200,
        consecutiveErrors: 0,
        consecutiveSameTool: 1,
        noopStreak: 0,
        hasProgress: true,
        uniqueTools: ['web_search'],
        recentTools: [{ name: 'web_search', success: true }],
        recoveryCount: 0,
      },
    });
    hub.recordRunEnd({
      runId,
      sessionId: 's1',
      messages: [msg({ role: 'user', content: 'hi' })],
      endReason: 'completed',
    });
    const obs = hub.getRunById(runId);
    expect(obs?.lifecycle?.turns).toBe(2);
    expect(obs?.lifecycle?.toolCalls).toBe(3);
    expect(obs?.lifecycle?.endReason).toBe('completed');
  });

  it('timeline ingest from runner-style events fills lifecycle counters', () => {
    const hub = new ObserverHub({ level: 'full' });
    const runId = hub.recordRunStart({ scope, messages: [] });
    for (const event of [
      { type: 'engine.start', data: {} },
      { type: 'iteration.start', data: {} },
      { type: 'turn.end', data: { usage: { totalTokens: 100 } } },
      { type: 'tool.exec.end', data: { toolName: 'web_search', hasError: false } },
      { type: 'engine.end', data: { reason: 'completed' } },
    ] as const) {
      hub.ingestEvent({
        type: event.type,
        timestamp: Date.now(),
        sessionId: 's1',
        data: event.data as Record<string, unknown>,
      });
    }
    const obs = hub.getRunById(runId);
    expect(obs?.timeline?.length).toBeGreaterThanOrEqual(4);
    expect(obs?.lifecycle?.turns).toBe(1);
    expect(obs?.lifecycle?.toolCalls).toBe(1);
    expect(obs?.lifecycle?.endReason).toBe('completed');
  });

  it('context.compact.* (Builder/ContextEngine emit path) lands on timeline', () => {
    const hub = new ObserverHub({ level: 'full' });
    const runId = hub.recordRunStart({ scope, messages: [] });
    // 模拟 Builder assemble emit 回调：只 ingest + 可选 bus
    const builderStyleEmit = (e: { type: string; sessionId?: string; data?: Record<string, unknown> }) => {
      hub.ingestEvent({
        type: e.type,
        timestamp: Date.now(),
        sessionId: e.sessionId,
        data: e.data ?? {},
      });
    };
    builderStyleEmit({
      type: 'context.compact.start',
      sessionId: 's1',
      data: { sessionId: 's1' },
    });
    builderStyleEmit({
      type: 'context.compact.end',
      sessionId: 's1',
      data: { sessionId: 's1', tokensBefore: 100, tokensAfter: 40 },
    });
    const obs = hub.getRunById(runId);
    const types = obs?.timeline?.map((t) => t.type) ?? [];
    expect(types).toContain('context.compact.start');
    expect(types).toContain('context.compact.end');
  });

  it('evicts lastLlmBySession when its run is dropped by retention', () => {
    const hub = new ObserverHub({
      level: 'full',
      retention: { runsPerSession: 1, timelineEvents: 50, messagesPerRun: 'full' },
    });
    const run1 = hub.recordRunStart({
      scope: { ...scope, runId: 'run_llm_keep_check_1' },
      messages: [msg({ role: 'user', content: 'a' })],
    });
    hub.recordLlmMessages({
      sessionId: 's1',
      runId: run1,
      messages: [{ role: 'user', content: 'a' }],
      estimatedTokens: 1,
    });
    expect(hub.getRunMessages('s1', { runId: run1, view: 'llm' })?.messages?.length).toBe(1);

    // 第二个 run 挤掉 run1（runsPerSession=1）
    const run2 = hub.recordRunStart({
      scope: { ...scope, runId: 'run_llm_keep_check_2' },
      messages: [msg({ role: 'user', content: 'b' })],
    });
    expect(hub.getRunById(run1)).toBeNull();
    // run1 的 llm 兜底应被清掉；新 run 尚无 llm → null
    const llmAfter = hub.getRunMessages('s1', { runId: run1, view: 'llm' });
    // record 不存在时 getRunMessages 走 latestRun(run2)，无 llm 则 null
    expect(llmAfter?.messages?.length ?? 0).toBe(0);
    expect(run2).toBeTruthy();
  });

  it('security / memory / tool.effect channels capture into observatory', () => {
    const hub = new ObserverHub({ level: 'full' });
    expect(hub.getConfig().channels.security).toBe(true);
    expect(hub.getConfig().channels.memory).toBe(true);
    expect(hub.getConfig().channels['tool.effect']).toBe(true);

    const runId = hub.recordRunStart({
      scope: { ...scope, runId: 'run_sec_mem_tool' },
      messages: [],
    });

    hub.ingestEvent({
      type: 'security.blocked',
      timestamp: Date.now(),
      sessionId: 's1',
      data: {
        reason: 'blocked shell',
        toolName: 'bash',
        action: 'block',
        severity: 'critical',
        violations: [{ type: 'command_injection', severity: 'critical', description: 'curl|bash' }],
      },
    });
    hub.ingestEvent({
      type: 'tool.exec.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: {
        toolName: 'web_search',
        hasError: false,
        durationMs: 12,
      },
    });
    hub.ingestEvent({
      type: 'tool.exec.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: {
        toolName: 'memory_store',
        hasError: false,
        args: { type: 'fact', proposition: 'User prefers dark mode' },
        result: { stored: true, id: 'mem_1', type: 'fact', status: 'active' },
      },
    });
    hub.ingestEvent({
      type: 'tool.exec.end',
      timestamp: Date.now(),
      sessionId: 's1',
      data: {
        toolName: 'memory_search',
        hasError: false,
        args: { query: 'dark mode' },
        result: { results: [{ id: 'mem_1' }], total: 1 },
      },
    });

    const obs = hub.getRunById(runId);
    expect(obs?.securityEvents?.length).toBe(1);
    expect(obs?.securityEvents?.[0]?.type).toBe('security.blocked');
    expect(obs?.securityEvents?.[0]?.toolName).toBe('bash');
    expect(obs?.toolEffect?.cwd).toBe('/tmp/work');
    expect(obs?.toolEffect?.isolation).toBe('none');
    expect(obs?.toolEffect?.tools.find((t) => t.name === 'web_search')?.calls).toBe(1);
    expect(obs?.memoryActivity?.stores).toBe(1);
    expect(obs?.memoryActivity?.storedOk).toBe(1);
    expect(obs?.memoryActivity?.searches).toBe(1);
    expect(obs?.memoryActivity?.searchHits).toBe(1);
    expect(obs?.memoryActivity?.entries[0]?.memoryId).toBe('mem_1');
  });

  it('level=off disables security/memory/tool.effect channels', () => {
    const cfg = resolveObserverConfig({ level: 'off' });
    expect(cfg.channels.security).toBe(false);
    expect(cfg.channels.memory).toBe(false);
    expect(cfg.channels['tool.effect']).toBe(false);
  });

  it('P1: llm view + guard metrics + entry/final diff + layers in hub', () => {
    const hub = new ObserverHub({ level: 'full' });
    const entry: Message[] = [msg({ role: 'user', content: 'hi' })];
    const runId = hub.recordRunStart({ scope, messages: entry });

    hub.recordLlmMessages({
      sessionId: 's1',
      runId,
      messages: [
        { role: 'system', content: 'sp' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok' },
      ],
      estimatedTokens: 42,
    });

    hub.ingestEvent({
      type: 'run.guard.metrics',
      timestamp: Date.now(),
      sessionId: 's1',
      data: {
        iteration: 2,
        totalToolCalls: 3,
        totalTokens: 100,
        elapsedMs: 50,
        consecutiveErrors: 0,
        consecutiveSameTool: 1,
        noopStreak: 0,
        hasProgress: true,
        uniqueTools: ['bash'],
        recentTools: [{ name: 'bash', success: true }],
        recoveryCount: 0,
      },
    });

    hub.recordRunEnd({
      runId,
      sessionId: 's1',
      messages: [
        ...entry,
        msg({ role: 'assistant', content: 'reply', agentId: 'agent1' }),
      ],
      endReason: 'completed',
    });

    const obs = hub.getRunById(runId);
    expect(obs?.llmSummary?.count).toBe(3);
    expect(obs?.llmEstimatedTokens).toBe(42);
    expect(obs?.guardMetrics?.totalToolCalls).toBe(3);
    expect(obs?.messagesDiff?.entryCount).toBe(1);
    expect(obs?.messagesDiff?.finalCount).toBe(2);
    expect(obs?.messagesDiff?.added.length).toBe(1);

    const llm = hub.getRunMessages('s1', { runId, view: 'llm' });
    expect(llm?.view).toBe('llm');
    expect(llm?.summary.count).toBe(3);
  });

  it('summarizeLlmMessages counts by role', () => {
    const s = summarizeLlmMessages([
      { role: 'system', content: 'x' },
      { role: 'user', content: 'yy' },
    ]);
    expect(s.count).toBe(2);
    expect(s.byRole.system).toBe(1);
  });

  it('buildRunMessagesDiff lists added tail messages', () => {
    const entry = [msg({ role: 'user', content: 'a' })];
    const final = [
      msg({ role: 'user', content: 'a' }),
      msg({ role: 'assistant', content: 'bb', agentId: 'x' }),
    ];
    const d = buildRunMessagesDiff(entry, final);
    expect(d.added).toHaveLength(1);
    expect(d.added[0]?.role).toBe('assistant');
  });
});
