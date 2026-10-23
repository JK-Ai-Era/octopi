/**
 * 在途 Run 盲窗 overlay — LiveRunTracker + applyLiveRunOverlay
 *
 * 修复「浏览器刷新后在途 turn 执行过程不可见」的 C 面：已定形消息由转录
 * 增量落盘保证在盘；live 快照只补「未定形的流式正文 / running 工具」，
 * history 与 live 冲突时以 history 为权威。
 */

import { describe, it, expect } from 'vitest';
import { LiveRunTracker } from '@octopi-agent/gateway/protocols/live-run-tracker.js';
import { HttpChannelAdapter } from '@octopi-agent/gateway/protocols/http.js';
import { applyLiveRunOverlay } from '@octopi-agent/gateway/web/conversation/live-overlay.js';
import type { ConversationItem, ToolConversationItem } from '@octopi-agent/gateway/web/conversation/types.js';

describe('LiveRunTracker', () => {
  it('流式 delta 累积为未定形正文，status=streaming', () => {
    const t = new LiveRunTracker();
    t.observe('s1', { type: 'llm_stream_delta', data: { delta: '你' } });
    t.observe('s1', { type: 'llm_stream_delta', data: { delta: '好' } });
    const live = t.get('s1');
    expect(live!.streamingContent).toBe('你好');
    expect(live!.status).toBe('streaming');
  });

  it('tool.exec.start/end 追踪 running 工具，全部结束回 waiting', () => {
    const t = new LiveRunTracker();
    t.observe('s1', {
      type: 'tool.exec.start',
      data: { toolCallId: 'c1', toolName: 'file_read', args: { purpose: '读文件' } },
      timestamp: 100,
    });
    t.observe('s1', { type: 'tool.exec.start', data: { toolCallId: 'c2', toolName: 'shell' } });
    expect(t.get('s1')!.status).toBe('tools');
    expect(t.get('s1')!.runningTools.map((x) => x.toolCallId)).toEqual(['c1', 'c2']);
    expect(t.get('s1')!.runningTools[0].purpose).toBe('读文件');

    t.observe('s1', { type: 'tool.exec.end', data: { toolCallId: 'c1' } });
    expect(t.get('s1')!.status).toBe('tools');
    t.observe('s1', { type: 'tool.exec.end', data: { toolCallId: 'c2' } });
    expect(t.get('s1')!.status).toBe('waiting');
    expect(t.get('s1')!.runningTools).toHaveLength(0);
  });

  it('tool.exec.start 清流式缓冲（定形正文已在转录，overlay 不得重复渲染）', () => {
    const t = new LiveRunTracker();
    t.observe('s1', { type: 'llm_stream_delta', data: { delta: '定形前的正文' } });
    t.observe('s1', { type: 'tool.exec.start', data: { toolCallId: 'c1', toolName: 'shell' } });
    const live = t.get('s1')!;
    expect(live.streamingContent).toBe('');
    expect(live.streamingReasoning).toBe('');
  });

  it('model.call.start 清上一轮流式缓冲', () => {
    const t = new LiveRunTracker();
    t.observe('s1', { type: 'llm_stream_delta', data: { delta: '第一轮' } });
    t.observe('s1', { type: 'model.call.start', data: {} });
    expect(t.get('s1')!.streamingContent).toBe('');
    expect(t.get('s1')!.status).toBe('waiting');
  });

  it('终态事件清除现场（Run 不活跃 → 无 overlay）', () => {
    for (const type of ['engine.end', 'aborted', 'engine.error', 'interrupted']) {
      const t = new LiveRunTracker();
      t.observe('s1', { type: 'llm_stream_delta', data: { delta: 'x' } });
      t.observe('s1', { type, data: {} });
      expect(t.get('s1')).toBeUndefined();
    }
  });

  it('无关事件不动现场；不同会话互不干扰', () => {
    const t = new LiveRunTracker();
    t.observe('s1', { type: 'llm_stream_delta', data: { delta: 'a' } });
    t.observe('s1', { type: 'session.updated', data: {} });
    t.observe('s2', { type: 'llm_stream_delta', data: { delta: 'b' } });
    expect(t.get('s1')!.streamingContent).toBe('a');
    expect(t.get('s2')!.streamingContent).toBe('b');
    t.clear('s1');
    expect(t.get('s1')).toBeUndefined();
    expect(t.get('s2')).toBeDefined();
  });

  it('无关事件不得为非活跃会话建条目（系统级广播不累积垃圾）', () => {
    const t = new LiveRunTracker();
    t.observe('*', { type: 'system.issue', data: {} });
    t.observe('never-ran', { type: 'session.updated', data: {} });
    expect(t.get('*')).toBeUndefined();
    expect(t.get('never-ran')).toBeUndefined();
  });

  it('turn.end 清流式缓冲（B1 回归：与 ConversationAdapter 同语义，防重复气泡/跨轮粘连）', () => {
    const t = new LiveRunTracker();
    t.observe('s1', { type: 'llm_stream_delta', data: { delta: '第一轮正文' } });
    t.observe('s1', { type: 'turn.end', data: { phase: 'final' } });
    const live = t.get('s1')!;
    expect(live.streamingContent).toBe('');
    expect(live.streamingReasoning).toBe('');
    // turn.end 后 overlay 不得再合成 streaming 条目（消息已定形入转录）
    expect(live.status).toBe('waiting');
  });

  it('engine.start 整现场复位（旧 Run 的 running 工具不得遗留给新 Run）', () => {
    const t = new LiveRunTracker();
    t.observe('s1', { type: 'llm_stream_delta', data: { delta: '旧正文' } });
    t.observe('s1', { type: 'tool.exec.start', data: { toolCallId: 'c1', toolName: 'shell' } });
    t.observe('s1', { type: 'engine.start', data: {} });
    const live = t.get('s1')!;
    expect(live.runningTools).toHaveLength(0);
    expect(live.streamingContent).toBe('');
    expect(live.status).toBe('waiting');
  });

  it('interrupted 清现场；model.call.error 可恢复不清现场', () => {
    const t1 = new LiveRunTracker();
    t1.observe('s1', { type: 'llm_stream_delta', data: { delta: 'x' } });
    t1.observe('s1', { type: 'interrupted', data: {} });
    expect(t1.get('s1')).toBeUndefined();

    const t2 = new LiveRunTracker();
    t2.observe('s2', { type: 'llm_stream_delta', data: { delta: 'y' } });
    t2.observe('s2', { type: 'model.call.error', data: {} });
    expect(t2.get('s2')).toBeDefined();
  });
});

describe('applyLiveRunOverlay', () => {
  const baseItem: ToolConversationItem = {
    id: 'tool-1',
    role: 'tool',
    createdAt: 1,
    sessionId: 's1',
    source: 'history',
    toolName: 'file_read',
    toolCallId: 'done-1',
    status: 'success',
  };

  it('running 工具合成运行态条目并建 toolIndex', () => {
    const result = applyLiveRunOverlay('s1', [baseItem], {
      status: 'tools',
      streamingContent: '',
      streamingReasoning: '',
      runningTools: [
        {
          toolCallId: 'c9',
          name: 'shell',
          args: { purpose: '跑测试' },
          purpose: '跑测试',
          startedAt: 5,
        },
      ],
    });
    expect(result.items).toHaveLength(2);
    const running = result.items[1] as ToolConversationItem;
    expect(running.status).toBe('running');
    expect(running.toolCallId).toBe('c9');
    expect(running.purpose).toBe('跑测试');
    expect(result.toolIndex['c9']).toBe(running.id);
  });

  it('流式正文合成 streaming assistant 条目并恢复 adapter 状态', () => {
    const result = applyLiveRunOverlay('s1', [], {
      status: 'streaming',
      streamingContent: '正在写',
      streamingReasoning: '思考中',
      runningTools: [],
    });
    const ast = result.items[0];
    expect(ast.role).toBe('assistant');
    expect((ast as { status?: string }).status).toBe('streaming');
    expect((ast as { content?: string }).content).toBe('正在写');
    expect(result.adapterState.streamingContent).toBe('正在写');
    expect(result.adapterState.streamingReasoning).toBe('思考中');
    expect(result.adapterState.currentAssistantId).toBe(ast.id);
  });

  it('同 toolCallId 已在 history 时以 history 为权威，不重复合成', () => {
    const result = applyLiveRunOverlay('s1', [baseItem], {
      status: 'tools',
      streamingContent: '',
      streamingReasoning: '',
      runningTools: [{ toolCallId: 'done-1', name: 'file_read', startedAt: 2 }],
    });
    expect(result.items).toHaveLength(1);
    expect(result.toolIndex).toEqual({});
  });

  it('空 live（无工具无流式）items 原样返回', () => {
    const items: ConversationItem[] = [baseItem];
    const result = applyLiveRunOverlay('s1', items, {
      status: 'waiting',
      streamingContent: '',
      streamingReasoning: '',
      runningTools: [],
    });
    expect(result.items).toBe(items);
  });

  it('二次应用幂等：旧合成条目被重建而非重复；既有 streaming 条目被接续', () => {
    const live = {
      status: 'streaming' as const,
      streamingContent: '正文',
      streamingReasoning: '',
      runningTools: [{ toolCallId: 'c1', name: 'shell', startedAt: 1 }],
    };
    const first = applyLiveRunOverlay('s1', [baseItem], live);
    expect(first.items).toHaveLength(3);

    const second = applyLiveRunOverlay('s1', first.items, {
      ...live,
      streamingContent: '正文更新',
      runningTools: [],
    });
    // 旧 live-tool / live-assistant 被剔除重建，不叠加
    const assistants = second.items.filter((it) => it.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as { content?: string }).content).toBe('正文更新');
    expect(second.items.filter((it) => it.role === 'tool')).toHaveLength(1);

    // 事件路径已插入的 streaming 条目（非合成 id）不重复合成，但被接续
    const eventItem = {
      id: 'ast-real',
      role: 'assistant' as const,
      createdAt: 3,
      sessionId: 's1',
      source: 'runtime' as const,
      status: 'streaming' as const,
      content: '事件流正文',
    };
    const third = applyLiveRunOverlay('s1', [baseItem, eventItem], {
      status: 'streaming',
      streamingContent: '事件流正文续',
      streamingReasoning: '',
      runningTools: [],
    });
    expect(third.items.filter((it) => it.role === 'assistant')).toHaveLength(1);
    expect(third.adapterState.currentAssistantId).toBe('ast-real');
    expect(third.adapterState.streamingContent).toBe('事件流正文续');
  });
});

describe('HttpChannelAdapter live 快照（observe → getLiveRun 链路）', () => {
  function makeAdapter(): HttpChannelAdapter {
    return new HttpChannelAdapter({
      port: 0,
      host: '127.0.0.1',
      path: '/chat',
      enableWebSocket: true,
    } as never);
  }

  it('broadcastEvent 出口聚合，按 event.sessionId 可查（与 messages API 查询键一致）', () => {
    const adapter = makeAdapter();
    adapter.broadcastEvent('agent:s1', {
      type: 'llm_stream_delta',
      sessionId: 's1',
      timestamp: 1,
      data: { delta: 'hi' },
    } as never);
    // 查询键 = 纯 sessionId（gateway.collectLiveRun 的口径）
    expect(adapter.getLiveRun('s1')!.streamingContent).toBe('hi');
    expect(adapter.getLiveRun('agent:s1')).toBeUndefined();
  });

  it('event.sessionId 缺失时回退 sessionKey（防御路径，同 key 清除）', () => {
    const adapter = makeAdapter();
    adapter.broadcastEvent('agent:s2', {
      type: 'llm_stream_delta',
      timestamp: 1,
      data: { delta: 'x' },
    } as never);
    expect(adapter.getLiveRun('agent:s2')).toBeDefined();
    // 生产路径事件恒带 sessionId（adaptLoopEvent 全量带 meta.sessionId）；
    // 同一事件流内 key 不分裂：终态按同一 key 清除
    adapter.broadcastEvent('agent:s2', {
      type: 'engine.end',
      timestamp: 2,
      data: {},
    } as never);
    expect(adapter.getLiveRun('agent:s2')).toBeUndefined();
  });
});
