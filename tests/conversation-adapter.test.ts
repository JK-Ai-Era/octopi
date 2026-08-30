import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationAdapter } from '../src/integration/web/conversation/adapter.js';
import type {
  ConversationItem,
  AssistantConversationItem,
  ToolConversationItem,
  SystemConversationItem,
  UserConversationItem,
} from '../src/integration/web/conversation/types.js';
import type { AgentEventEnvelope, MessageRecord } from '../src/integration/web/sdk/client.js';

function roleItems(items: ConversationItem[], role: string) {
  return items.filter((i) => i.role === role);
}

describe('ConversationAdapter', () => {
  let adapter: ConversationAdapter;
  let items: ConversationItem[];
  const sid = 'test-session';

  beforeEach(() => {
    adapter = new ConversationAdapter();
    items = [];
  });

  // ──────────────────────────────────
  // buildHistoryItems (static)
  // ──────────────────────────────────

  describe('buildHistoryItems', () => {
    it('maps user messages', () => {
      const msgs: MessageRecord[] = [
        { role: 'user', content: 'hello', timestamp: 1000 },
      ];
      const result = ConversationAdapter.buildHistoryItems(msgs, sid);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
      expect((result[0] as UserConversationItem).content).toBe('hello');
      expect(result[0].source).toBe('history');
      expect(result[0].sessionId).toBe(sid);
    });

    it('maps assistant messages as completed', () => {
      const msgs: MessageRecord[] = [
        { role: 'assistant', content: 'hi there', timestamp: 2000 },
      ];
      const result = ConversationAdapter.buildHistoryItems(msgs, sid);
      expect(result).toHaveLength(1);
      const item = result[0] as AssistantConversationItem;
      expect(item.role).toBe('assistant');
      expect(item.status).toBe('completed');
      expect(item.content).toBe('hi there');
    });

    it('maps tool messages', () => {
      const msgs: MessageRecord[] = [
        {
          role: 'tool',
          content: { output: 'ok' },
          timestamp: 3000,
          metadata: { toolName: 'search', toolCallId: 'tc1', isError: false },
        },
      ];
      const result = ConversationAdapter.buildHistoryItems(msgs, sid);
      expect(result).toHaveLength(1);
      const item = result[0] as ToolConversationItem;
      expect(item.role).toBe('tool');
      expect(item.toolName).toBe('search');
      expect(item.toolCallId).toBe('tc1');
      expect(item.status).toBe('success');
    });

    it('maps tool messages with toolResults array (Gateway format)', () => {
      const msgs = [
        {
          role: 'tool',
          content: '',
          timestamp: 3000,
          toolResults: [
            { toolCallId: 'tc1', name: 'search', result: 'found it', isError: false },
            { toolCallId: 'tc2', name: 'read_file', result: null, error: 'permission denied', isError: true },
          ],
        },
      ] as any[];
      const result = ConversationAdapter.buildHistoryItems(msgs, sid);
      expect(result).toHaveLength(2);
      expect((result[0] as ToolConversationItem).toolName).toBe('search');
      expect((result[0] as ToolConversationItem).status).toBe('success');
      expect((result[0] as ToolConversationItem).toolCallId).toBe('tc1');
      expect((result[1] as ToolConversationItem).toolName).toBe('read_file');
      expect((result[1] as ToolConversationItem).status).toBe('error');
      expect((result[1] as ToolConversationItem).error).toContain('permission denied');
    });

    it('maps assistant messages with toolCalls array', () => {
      const msgs = [
        {
          role: 'assistant',
          content: '',
          timestamp: 2000,
          toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'test' } }],
        },
      ] as any[];
      const result = ConversationAdapter.buildHistoryItems(msgs, sid);
      expect(result).toHaveLength(1);
      const ast = result[0] as AssistantConversationItem;
      expect(ast.toolCalls).toEqual(['tc1']);
    });

    it('maps tool error messages', () => {
      const msgs: MessageRecord[] = [
        {
          role: 'tool',
          content: 'failed',
          timestamp: 3000,
          metadata: { toolName: 'fetch', toolCallId: 'tc2', isError: true },
        },
      ];
      const result = ConversationAdapter.buildHistoryItems(msgs, sid);
      const item = result[0] as ToolConversationItem;
      expect(item.status).toBe('error');
    });

    it('maps system messages', () => {
      const msgs: MessageRecord[] = [
        { role: 'system', content: 'session started', timestamp: 500 },
      ];
      const result = ConversationAdapter.buildHistoryItems(msgs, sid);
      const item = result[0] as SystemConversationItem;
      expect(item.role).toBe('system');
      expect(item.kind).toBe('info');
      expect(item.message).toBe('session started');
    });

    it('falls back to system for unknown roles', () => {
      const msgs: MessageRecord[] = [
        { role: 'unknown', content: 'something', timestamp: 600 },
      ];
      const result = ConversationAdapter.buildHistoryItems(msgs, sid);
      const item = result[0] as SystemConversationItem;
      expect(item.role).toBe('system');
      expect(item.message).toContain('unknown');
    });

    it('handles array content blocks', () => {
      const msgs: MessageRecord[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }],
          timestamp: 700,
        },
      ];
      const result = ConversationAdapter.buildHistoryItems(msgs, sid);
      expect((result[0] as UserConversationItem).content).toBe('hello world');
    });

    it('handles mixed role conversation', () => {
      const msgs: MessageRecord[] = [
        { role: 'user', content: 'q1', timestamp: 100 },
        { role: 'assistant', content: 'a1', timestamp: 200 },
        { role: 'user', content: 'q2', timestamp: 300 },
        { role: 'assistant', content: 'a2', timestamp: 400 },
      ];
      const result = ConversationAdapter.buildHistoryItems(msgs, sid);
      expect(result).toHaveLength(4);
      expect(result.map((i) => i.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    });
  });

  // ──────────────────────────────────
  // applyEvent — streaming flow
  // ──────────────────────────────────

  describe('applyEvent — streaming', () => {
    it('creates streaming assistant on first delta', () => {
      const event: AgentEventEnvelope = { type: 'llm_stream_delta', data: { delta: 'Hi' } };
      const result = adapter.applyEvent(event, sid, items);

      expect(result.changed).toBe(true);
      expect(result.items).toHaveLength(1);
      const ast = result.items[0] as AssistantConversationItem;
      expect(ast.role).toBe('assistant');
      expect(ast.status).toBe('streaming');
      expect(ast.content).toBe('Hi');
      expect(ast.source).toBe('runtime');
      expect(result.streaming.active).toBe(true);
      expect(result.streaming.content).toBe('Hi');
    });

    it('appends deltas to existing streaming item', () => {
      let r = adapter.applyEvent({ type: 'llm_stream_delta', data: { delta: 'Hel' } }, sid, items);
      items = r.items;
      r = adapter.applyEvent({ type: 'llm_stream_delta', data: { delta: 'lo' } }, sid, items);
      items = r.items;

      expect(items).toHaveLength(1);
      expect((items[0] as AssistantConversationItem).content).toBe('Hello');
      expect(r.streaming.content).toBe('Hello');
    });

    it('finalizes streaming on turn.end', () => {
      let r = adapter.applyEvent({ type: 'llm_stream_delta', data: { delta: 'partial' } }, sid, items);
      items = r.items;
      r = adapter.applyEvent({ type: 'turn.end', data: { content: 'final' } }, sid, items);
      items = r.items;

      const ast = items[0] as AssistantConversationItem;
      expect(ast.status).toBe('completed');
      expect(ast.content).toBe('final');
      expect(r.streaming.active).toBe(false);
      expect(r.streaming.content).toBe('');
    });

    it('keeps streamed content when turn.end has no explicit content', () => {
      let r = adapter.applyEvent({ type: 'llm_stream_delta', data: { delta: 'streamed' } }, sid, items);
      items = r.items;
      r = adapter.applyEvent({ type: 'turn.end', data: {} }, sid, items);
      items = r.items;

      const ast = items[0] as AssistantConversationItem;
      expect(ast.status).toBe('completed');
      expect(ast.content).toBe('streamed');
    });

    it('ignores empty deltas', () => {
      const r = adapter.applyEvent({ type: 'llm_stream_delta', data: { delta: '' } }, sid, items);
      expect(r.changed).toBe(false);
      expect(r.items).toHaveLength(0);
    });
  });

  // ──────────────────────────────────
  // applyEvent — tool lifecycle
  // ──────────────────────────────────

  describe('applyEvent — tools', () => {
    it('creates tool item on tool.exec.start', () => {
      const event: AgentEventEnvelope = {
        type: 'tool.exec.start',
        data: { toolCallId: 'tc1', toolName: 'search' },
      };
      const r = adapter.applyEvent(event, sid, items);

      expect(r.changed).toBe(true);
      const tool = r.items[0] as ToolConversationItem;
      expect(tool.role).toBe('tool');
      expect(tool.toolName).toBe('search');
      expect(tool.toolCallId).toBe('tc1');
      expect(tool.status).toBe('running');
      expect(r.toolIndex['tc1']).toBeDefined();
    });

    it('updates tool to success on tool.exec.end', () => {
      let r = adapter.applyEvent(
        { type: 'tool.exec.start', data: { toolCallId: 'tc1', toolName: 'search' } },
        sid,
        items,
      );
      items = r.items;
      r = adapter.applyEvent(
        { type: 'tool.exec.end', data: { toolCallId: 'tc1', result: 'ok' } },
        sid,
        items,
      );

      const tool = r.items[0] as ToolConversationItem;
      expect(tool.status).toBe('success');
      expect(tool.result).toBe('ok');
    });

    it('updates tool to error on tool.exec.end with isError', () => {
      let r = adapter.applyEvent(
        { type: 'tool.exec.start', data: { toolCallId: 'tc1', toolName: 'fetch' } },
        sid,
        items,
      );
      items = r.items;
      r = adapter.applyEvent(
        { type: 'tool.exec.end', data: { toolCallId: 'tc1', isError: true, result: 'timeout' } },
        sid,
        items,
      );

      const tool = r.items[0] as ToolConversationItem;
      expect(tool.status).toBe('error');
      expect(tool.error).toBe('timeout');
    });

    it('links tool calls to assistant item', () => {
      // First create a streaming assistant
      let r = adapter.applyEvent({ type: 'llm_stream_delta', data: { delta: '...' } }, sid, items);
      items = r.items;
      const assistantId = items[0].id;

      // Then start a tool
      r = adapter.applyEvent(
        { type: 'tool.exec.start', data: { toolCallId: 'tc1', toolName: 'run' } },
        sid,
        items,
      );
      items = r.items;

      const ast = items.find((i) => i.id === assistantId) as AssistantConversationItem;
      expect(ast.toolCalls).toContain('tc1');
    });
  });

  // ──────────────────────────────────
  // applyEvent — system notices
  // ──────────────────────────────────

  describe('applyEvent — system notices', () => {
    it('creates aborted notice', () => {
      const r = adapter.applyEvent({ type: 'aborted' }, sid, items);
      const sys = r.items.find((i) => i.role === 'system') as SystemConversationItem;
      expect(sys).toBeDefined();
      expect(sys.kind).toBe('aborted');
    });

    it('creates error notice on engine.error', () => {
      const r = adapter.applyEvent(
        { type: 'engine.error', data: { error: 'something broke' } },
        sid,
        items,
      );
      const sys = r.items.find((i) => i.role === 'system') as SystemConversationItem;
      expect(sys).toBeDefined();
      expect(sys.kind).toBe('error');
      expect(sys.message).toBe('something broke');
    });

    it('marks streaming assistant as error on engine.error', () => {
      let r = adapter.applyEvent({ type: 'llm_stream_delta', data: { delta: '...' } }, sid, items);
      items = r.items;
      r = adapter.applyEvent({ type: 'engine.error', data: { error: 'fail' } }, sid, items);

      const ast = r.items.find((i) => i.role === 'assistant') as AssistantConversationItem;
      expect(ast.status).toBe('error');
    });

    it('creates blocked notice', () => {
      const r = adapter.applyEvent(
        { type: 'security.blocked', data: { reason: 'unsafe content' } },
        sid,
        items,
      );
      const sys = r.items.find((i) => i.role === 'system') as SystemConversationItem;
      expect(sys.kind).toBe('blocked');
      expect(sys.message).toBe('unsafe content');
    });

    it('creates truncated notice', () => {
      const r = adapter.applyEvent(
        { type: 'context.truncated', data: { from: 100, to: 50 } },
        sid,
        items,
      );
      const sys = r.items.find((i) => i.role === 'system') as SystemConversationItem;
      expect(sys.kind).toBe('truncated');
      expect(sys.message).toContain('100');
      expect(sys.message).toContain('50');
    });

    it('creates retry notice', () => {
      const r = adapter.applyEvent({ type: 'empty_response_retry' }, sid, items);
      const sys = r.items.find((i) => i.role === 'system') as SystemConversationItem;
      expect(sys.kind).toBe('retry');
    });

    it('creates warning on loop_detected', () => {
      const r = adapter.applyEvent(
        { type: 'loop_detected', data: { message: 'repeating' } },
        sid,
        items,
      );
      const sys = r.items.find((i) => i.role === 'system') as SystemConversationItem;
      expect(sys.kind).toBe('warning');
      expect(sys.message).toBe('repeating');
    });

    it('creates warning on budget.exceeded', () => {
      const r = adapter.applyEvent(
        { type: 'budget.exceeded', data: { status: 'exceeded' } },
        sid,
        items,
      );
      const sys = r.items.find((i) => i.role === 'system') as SystemConversationItem;
      expect(sys.kind).toBe('warning');
      expect(sys.message).toContain('exceeded');
    });
  });

  // ──────────────────────────────────
  // injectUserMessage
  // ──────────────────────────────────

  describe('injectUserMessage', () => {
    it('adds a user item', () => {
      const result = adapter.injectUserMessage('hello', sid, items);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
      expect((result[0] as UserConversationItem).content).toBe('hello');
      expect(result[0].source).toBe('runtime');
    });

    it('preserves existing items', () => {
      items = adapter.injectUserMessage('first', sid, items);
      items = adapter.injectUserMessage('second', sid, items);
      expect(items).toHaveLength(2);
    });
  });

  // ──────────────────────────────────
  // reset
  // ──────────────────────────────────

  describe('reset', () => {
    it('clears internal state', () => {
      // Build up some state
      let r = adapter.applyEvent({ type: 'llm_stream_delta', data: { delta: '...' } }, sid, []);
      r = adapter.applyEvent(
        { type: 'tool.exec.start', data: { toolCallId: 'tc1', toolName: 'x' } },
        sid,
        r.items,
      );

      adapter.reset();

      // After reset, new events should create fresh items
      r = adapter.applyEvent({ type: 'llm_stream_delta', data: { delta: 'new' } }, sid, []);
      expect(r.items).toHaveLength(1);
      expect((r.items[0] as AssistantConversationItem).content).toBe('new');
    });
  });

  // ──────────────────────────────────
  // Full conversation flow
  // ──────────────────────────────────

  describe('full conversation flow', () => {
    it('handles user → streaming → tool → turn.end sequence', () => {
      // User sends message
      items = adapter.injectUserMessage('search something', sid, items);
      expect(items).toHaveLength(1);

      // Assistant starts streaming
      let r = adapter.applyEvent({ type: 'llm_stream_delta', data: { delta: 'Let me...' } }, sid, items);
      items = r.items;
      expect(items).toHaveLength(2);

      // Tool starts
      r = adapter.applyEvent(
        { type: 'tool.exec.start', data: { toolCallId: 'tc1', toolName: 'search' } },
        sid,
        items,
      );
      items = r.items;
      expect(items).toHaveLength(3);

      // Tool finishes
      r = adapter.applyEvent(
        { type: 'tool.exec.end', data: { toolCallId: 'tc1', result: 'found it' } },
        sid,
        items,
      );
      items = r.items;
      const tool = items.find((i) => i.role === 'tool') as ToolConversationItem;
      expect(tool.status).toBe('success');

      // Turn ends
      r = adapter.applyEvent(
        { type: 'turn.end', data: { content: 'Here is what I found' } },
        sid,
        items,
      );
      items = r.items;
      const ast = items.find((i) => i.role === 'assistant') as AssistantConversationItem;
      expect(ast.status).toBe('completed');
      expect(ast.content).toBe('Here is what I found');

      // Final state: user + assistant + tool
      expect(items).toHaveLength(3);
      expect(roleItems(items, 'user')).toHaveLength(1);
      expect(roleItems(items, 'assistant')).toHaveLength(1);
      expect(roleItems(items, 'tool')).toHaveLength(1);
    });

    it('handles aborted mid-stream', () => {
      let r = adapter.applyEvent({ type: 'llm_stream_delta', data: { delta: 'partial' } }, sid, items);
      items = r.items;
      r = adapter.applyEvent({ type: 'aborted' }, sid, items);
      items = r.items;

      const ast = items.find((i) => i.role === 'assistant') as AssistantConversationItem;
      expect(ast.status).toBe('completed');

      const sys = items.find((i) => i.role === 'system') as SystemConversationItem;
      expect(sys.kind).toBe('aborted');
      expect(r.streaming.active).toBe(false);
    });

    it('handles error mid-stream', () => {
      let r = adapter.applyEvent({ type: 'llm_stream_delta', data: { delta: '...' } }, sid, items);
      items = r.items;
      r = adapter.applyEvent(
        { type: 'model.call.error', data: { error: 'rate limited' } },
        sid,
        items,
      );
      items = r.items;

      const ast = items.find((i) => i.role === 'assistant') as AssistantConversationItem;
      expect(ast.status).toBe('error');
      expect(ast.error).toBe('rate limited');

      const sys = items.find((i) => i.role === 'system') as SystemConversationItem;
      expect(sys.kind).toBe('error');
    });

    it('all items have stable unique IDs', () => {
      items = adapter.injectUserMessage('q', sid, items);
      let r = adapter.applyEvent({ type: 'llm_stream_delta', data: { delta: 'a' } }, sid, items);
      items = r.items;
      r = adapter.applyEvent(
        { type: 'tool.exec.start', data: { toolCallId: 'tc1', toolName: 'x' } },
        sid,
        items,
      );
      items = r.items;

      const ids = items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
