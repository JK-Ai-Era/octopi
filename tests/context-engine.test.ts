/**
 * ContextEngine 测试
 *
 * 测试新的上下文引擎接口和实现：
 * - TokenEstimator
 * - MessageSelector
 * - 机械降级阶梯（B′：打码 → 账本截断）
 * - BudgetAllocator
 * - DefaultContextEngine
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTokenUsage } from '@octopi-agent/core/types/step.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage, LLMToolDefinition } from '@octopi-agent/core/interfaces/model-provider.js';
import type {
  ContextEngine,
  AssembleParams,
  TokenEstimator,
  SummarizeFunction,
} from '@octopi-agent/engine/harness/context/types.js';
import { HeuristicTokenEstimator, estimateTextTokens, estimateLLMMessages } from '@octopi-agent/engine/harness/context/token-estimator.js';
import { ContextSizeLedger } from '@octopi-agent/engine/harness/context/context-size-ledger.js';
import {
  estimateContentBlock,
  estimateToolCallTokens,
  estimateTokens,
} from '@octopi-agent/engine/harness/context/token-estimate-fns.js';
import {
  IMAGE_TOKEN_ESTIMATE,
  AUDIO_TOKEN_ESTIMATE,
  VIDEO_TOKEN_ESTIMATE,
  MESSAGE_OVERHEAD_TOKENS,
  JSON_CHARS_PER_TOKEN,
  TOOL_RESULT_CHARS_PER_TOKEN,
} from '@octopi-agent/engine/harness/context/token-constants.js';
import { DefaultMessageSelector } from '@octopi-agent/engine/harness/context/message-selector.js';
import {
  buildToolCallLedger,
  ledgerTruncate,
  mechanicalDegrade,
} from '@octopi-agent/engine/harness/context/capabilities/compact/mechanical.js';
import { MECHANICAL_NOTICE_TRUNCATED } from '@octopi-agent/engine/harness/context/capabilities/compact/messages.js';
import { alignViewSplit } from '@octopi-agent/engine/harness/context/capabilities/compact/view-split.js';
import { DefaultBudgetAllocator } from '@octopi-agent/engine/harness/context/budget-allocator.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { SmartRouter } from '@octopi-agent/engine/harness/context/smart-router.js';

// ── 测试工具函数 ──

function createMessage(role: Message['role'], content: string, extra?: Partial<Message>): Message {
  return {
    role,
    content,
    timestamp: Date.now(),
    ...extra,
  };
}

function createToolCallMessage(name: string, args: Record<string, unknown> = {}): Message {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{
      id: `call_${Date.now()}`,
      name,
      arguments: args,
    }],
    timestamp: Date.now(),
  };
}

function createToolResultMessage(toolCallId: string, name: string, result: string): Message {
  return {
    role: 'tool',
    content: '',
    toolResults: [{
      toolCallId,
      name,
      result,
    }],
    timestamp: Date.now(),
  };
}

function createToolDefinition(name: string, description: string): LLMToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'Input parameter',
          },
        },
        required: ['input'],
      },
    },
  };
}

// ── TokenEstimator 测试 ──

describe('HeuristicTokenEstimator', () => {
  let estimator: HeuristicTokenEstimator;

  beforeEach(() => {
    estimator = new HeuristicTokenEstimator();
  });

  describe('estimateText', () => {
    it('should return 0 for empty string', () => {
      expect(estimator.estimateText('')).toBe(0);
    });

    it('should estimate ASCII text', () => {
      // 4 chars ≈ 1 token
      const text = 'Hello, world!'; // 13 chars
      const tokens = estimator.estimateText(text);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(10);
    });

    it('should estimate Chinese text', () => {
      // CJK 感知估算：4 CJK chars → adjustedChars=16 → 16/4=4 tokens
      const text = '你好世界'; // 4 chars
      const tokens = estimator.estimateText(text);
      expect(tokens).toBeGreaterThanOrEqual(4);
      expect(tokens).toBeLessThan(10);
    });

    it('should handle mixed content', () => {
      const text = 'Hello 你好 world 世界';
      const tokens = estimator.estimateText(text);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('estimateMessage', () => {
    it('should estimate user message', () => {
      const msg = createMessage('user', 'Hello, how are you?');
      const tokens = estimator.estimateMessage(msg);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should estimate assistant message with tool calls', () => {
      const msg = createToolCallMessage('read_file', { path: '/test.txt' });
      const tokens = estimator.estimateMessage(msg);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should estimate tool result message', () => {
      const msg = createToolResultMessage('call_1', 'read_file', 'File contents here');
      const tokens = estimator.estimateMessage(msg);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('estimateMessages', () => {
    it('should estimate multiple messages', () => {
      const messages = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi there!'),
        createMessage('user', 'How are you?'),
      ];
      const tokens = estimator.estimateMessages(messages);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should return 0 for empty array', () => {
      expect(estimator.estimateMessages([])).toBe(0);
    });
  });

  describe('estimateTools', () => {
    it('should estimate tool definitions', () => {
      const tools = [
        createToolDefinition('read_file', 'Read a file from disk'),
        createToolDefinition('write_file', 'Write a file to disk'),
      ];
      const tokens = estimator.estimateTools(tools);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should return 0 for empty array', () => {
      expect(estimator.estimateTools([])).toBe(0);
    });
  });
});

// ── estimateTextTokens 函数测试 ──

describe('estimateTextTokens', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTextTokens('')).toBe(0);
  });

  it('should handle long text with sampling', () => {
    const longText = 'a'.repeat(5000);
    const tokens = estimateTextTokens(longText);
    expect(tokens).toBeGreaterThan(0);
  });
});

// ── estimateContentBlock / estimateToolCallTokens ──

describe('estimateContentBlock', () => {
  it('should estimate text block via CJK-aware path', () => {
    expect(estimateContentBlock({ type: 'text', text: '你好' })).toBe(estimateTextTokens('你好'));
  });

  it('should estimate image / audio / input_audio / video blocks', () => {
    expect(estimateContentBlock({ type: 'image' })).toBe(IMAGE_TOKEN_ESTIMATE);
    expect(estimateContentBlock({ type: 'audio' })).toBe(AUDIO_TOKEN_ESTIMATE);
    expect(estimateContentBlock({ type: 'input_audio' })).toBe(AUDIO_TOKEN_ESTIMATE);
    expect(estimateContentBlock({ type: 'video' })).toBe(VIDEO_TOKEN_ESTIMATE);
  });

  it('counts unknown or file blocks by length (R4: no constant fallback)', () => {
    // 旧「return 10」常数兜底已废除（P1-c）：未知块按正文长度计
    expect(estimateContentBlock({ type: 'file' })).toBe(0);
    expect(estimateContentBlock({ type: 'unknown_xyz' })).toBe(0);
    expect(estimateContentBlock({})).toBe(0);
    const short = estimateContentBlock({ type: 'unknown_xyz', text: 'x'.repeat(30) });
    const long = estimateContentBlock({ type: 'unknown_xyz', text: 'x'.repeat(300) });
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short);
  });

  it('treats text block without text as zero-length (no constant)', () => {
    expect(estimateContentBlock({ type: 'text' })).toBe(0);
  });
});

describe('estimateToolCallTokens', () => {
  it('should count name tokens plus JSON args at JSON ratio', () => {
    const name = 'read_file';
    const args = { path: '/tmp/a.txt' };
    const argsStr = JSON.stringify(args);
    const expected =
      estimateTextTokens(name) + Math.ceil(argsStr.length / JSON_CHARS_PER_TOKEN);
    expect(estimateToolCallTokens([{ name, arguments: args }])).toBe(expected);
  });

  it('should not double-stringify string arguments', () => {
    const argsStr = '{"path":"/tmp/a.txt"}';
    const viaString = estimateToolCallTokens([{ name: 'read_file', arguments: argsStr }]);
    const viaObject = estimateToolCallTokens([
      { name: 'read_file', arguments: JSON.parse(argsStr) },
    ]);
    // 对象路径走 JSON.stringify，结果应与直接传同构 JSON 字符串一致
    expect(viaString).toBe(viaObject);
    // 且不应把字符串再包一层引号
    expect(viaString).toBe(
      estimateTextTokens('read_file') + Math.ceil(argsStr.length / JSON_CHARS_PER_TOKEN),
    );
  });

  it('should treat missing arguments as empty object', () => {
    const expected = estimateTextTokens('noop') + Math.ceil(JSON.stringify({}).length / JSON_CHARS_PER_TOKEN);
    expect(estimateToolCallTokens([{ name: 'noop' }])).toBe(expected);
  });

  it('should return 0 for empty list', () => {
    expect(estimateToolCallTokens([])).toBe(0);
  });
});

describe('HeuristicTokenEstimator.estimateMessage with tool calls', () => {
  it('should match estimateToolCallTokens for domain Message.toolCalls', () => {
    const estimator = new HeuristicTokenEstimator();
    const msg: Message = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'shell', arguments: { command: 'ls -la' } }],
      timestamp: Date.now(),
    };
    expect(estimator.estimateMessage(msg)).toBe(
      MESSAGE_OVERHEAD_TOKENS +
        estimateToolCallTokens([{ name: 'shell', arguments: { command: 'ls -la' } }]),
    );
  });

  it('should use denser ratio for tool results than for text', () => {
    const estimator = new HeuristicTokenEstimator();
    const resultText = 'x'.repeat(40);
    const msg: Message = {
      role: 'tool',
      content: '',
      toolResults: [{ toolCallId: 'c1', name: 'shell', result: resultText }],
      timestamp: Date.now(),
    };
    const expected =
      MESSAGE_OVERHEAD_TOKENS +
      Math.ceil(resultText.length / TOOL_RESULT_CHARS_PER_TOKEN);
    expect(estimator.estimateMessage(msg)).toBe(expected);
  });
});

describe('estimateLLMMessages shared block logic', () => {
  it('should apply audio/video estimates (not unknown-block fallback)', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'audio' },
          { type: 'video' },
          { type: 'input_audio' },
        ],
      },
    ];
    expect(estimateLLMMessages(messages)).toBe(
      MESSAGE_OVERHEAD_TOKENS + AUDIO_TOKEN_ESTIMATE + VIDEO_TOKEN_ESTIMATE + AUDIO_TOKEN_ESTIMATE,
    );
  });

  it('should estimate tool_calls via estimateToolCallTokens', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          { id: '1', type: 'function' as const, function: { name: 'search', arguments: '{"q":"hi"}' } },
        ],
      },
    ];
    expect(estimateLLMMessages(messages)).toBe(
      MESSAGE_OVERHEAD_TOKENS +
        estimateToolCallTokens([{ name: 'search', arguments: '{"q":"hi"}' }]),
    );
  });
});

describe('estimateTokens loose messages', () => {
  it('should count overhead and string content', () => {
    const tokens = estimateTokens([{ content: 'Hello world' }, { content: '你好世界' }, { content: null }]);
    expect(tokens).toBe(
      MESSAGE_OVERHEAD_TOKENS * 3 +
        estimateTextTokens('Hello world') +
        estimateTextTokens('你好世界'),
    );
  });
});

// ── MessageSelector 测试 ──

describe('DefaultMessageSelector', () => {
  let selector: DefaultMessageSelector;
  let estimator: HeuristicTokenEstimator;

  beforeEach(() => {
    selector = new DefaultMessageSelector();
    estimator = new HeuristicTokenEstimator();
  });

  describe('select', () => {
    it('should return empty result for empty messages', () => {
      const result = selector.select([], {
        maxTokens: 1000,
        protectFirstN: 3,
        protectLastN: 20,
      }, estimator);

      expect(result.kept).toEqual([]);
      expect(result.overflow).toEqual([]);
      expect(result.overflowTokens).toBe(0);
    });

    it('should keep all messages if within budget', () => {
      const messages = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi'),
      ];

      const result = selector.select(messages, {
        maxTokens: 10000,
        protectFirstN: 3,
        protectLastN: 20,
      }, estimator);

      expect(result.kept.length).toBe(2);
      expect(result.overflowTokens).toBe(0);
    });

    it('should protect first N messages', () => {
      const messages = Array.from({ length: 30 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`)
      );

      const result = selector.select(messages, {
        maxTokens: 100, // Very small budget
        protectFirstN: 3,
        protectLastN: 5,
      }, estimator);

      // First 3 should be in kept
      const firstThree = messages.slice(0, 3);
      for (const msg of firstThree) {
        expect(result.kept).toContainEqual(msg);
      }
    });

    it('protectLastN: 0 时不把全量当尾部保护（slice(-0) 回归）', () => {
      const messages = Array.from({ length: 30 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i} ${'x'.repeat(80)}`)
      );

      const result = selector.select(messages, {
        maxTokens: 100, // 极小预算
        protectFirstN: 0,
        protectLastN: 0,
      }, estimator);

      // 尾部保护为 0 时不得整批进保护区：超预算部分应进 overflow 而非全量 kept
      expect(result.overflow.length).toBeGreaterThan(0);
      expect(result.kept.length).toBeLessThan(30);
    });

    it('protectFirstN 为负数时与 0 等价（边界归一，不走 slice 负数语义）', () => {
      const messages = Array.from({ length: 6 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `m${i}-${'x'.repeat(120)}`)
      );
      const opts = (protectFirstN: number) => ({
        maxTokens: 120, // 超预算，切分语义可观测
        protectFirstN,
        protectLastN: 1,
      });
      const neg = selector.select(messages, opts(-3), estimator);
      const zero = selector.select(messages, opts(0), estimator);
      expect(neg.kept).toEqual(zero.kept);
      expect(neg.overflow).toEqual(zero.overflow);
    });

    it('should protect last N messages', () => {
      const messages = Array.from({ length: 30 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`)
      );

      const result = selector.select(messages, {
        maxTokens: 500, // Budget enough for tail protection
        protectFirstN: 3,
        protectLastN: 5,
      }, estimator);

      // Last 5 should be in kept
      const lastFive = messages.slice(-5);
      for (const msg of lastFive) {
        expect(result.kept).toContainEqual(msg);
      }
    });

    it('should not split tool_call/tool_result pairs', () => {
      const messages = [
        createMessage('user', 'Read file'),
        createToolCallMessage('read_file', { path: '/test.txt' }),
        createToolResultMessage('call_1', 'read_file', 'File contents'),
        createMessage('assistant', 'Here is the file'),
      ];

      const result = selector.select(messages, {
        maxTokens: 50, // Small budget to force overflow
        protectFirstN: 1,
        protectLastN: 1,
      }, estimator);

      // tool_call and tool_result should be kept together
      const hasToolCall = result.kept.some(m => m.toolCalls?.length);
      const hasToolResult = result.kept.some(m => m.toolResults?.length);

      if (hasToolCall) {
        expect(hasToolResult).toBe(true);
      }
    });
  });
});

// ── 机械降级（purpose 账本，单级）测试 ──

describe('buildToolCallLedger', () => {
  it('只保留 name + purpose，丢弃参数载荷与结果正文', () => {
    const messages = [
      createToolCallMessage('file_edit', {
        purpose: 'Add disposition row to P5',
        old_text: 'x'.repeat(4000),
        new_text: 'y'.repeat(4000),
      }),
      createToolResultMessage('call_0', 'file_edit', 'z'.repeat(4000)),
    ];
    const ledger = buildToolCallLedger(messages);
    expect(ledger).toContain('file_edit: Add disposition row to P5');
    expect(ledger).not.toContain('x'.repeat(200));
    expect(ledger).not.toContain('z'.repeat(200));
  });

  it('error 结果永不计略：附在对应调用行下（错误可追溯性优先）', () => {
    const call = createToolCallMessage('project_run', { purpose: 'Run regression' });
    const messages = [
      call,
      createMessage('tool', '', {
        toolResults: [
          { toolCallId: call.toolCalls![0]!.id, name: 'project_run', result: null, error: 'exit 1' },
        ],
      }),
    ];
    const ledger = buildToolCallLedger(messages);
    expect(ledger).toContain('- project_run: Run regression');
    expect(ledger).toContain('! project_run: exit 1');
    // error 行紧跟其调用行
    const lines = ledger.split('\n');
    expect(lines[1]?.trim().startsWith('!')).toBe(true);
  });

  it('purpose 缺失时诚实标注（不伪造、不整条丢弃）', () => {
    const messages = [createToolCallMessage('probe', {})];
    const ledger = buildToolCallLedger(messages);
    expect(ledger).toContain('- probe: (purpose not recorded)');
  });
});

describe('mechanicalDegrade（单级账本）', () => {
  let estimator: HeuristicTokenEstimator;

  beforeEach(() => {
    estimator = new HeuristicTokenEstimator();
  });

  it('整段替换为一条账本消息，账本比原文小得多', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      const call = createToolCallMessage('file_read', { purpose: `Read file ${i}`, path: `/f${i}` });
      messages.push(call);
      messages.push(createToolResultMessage(call.toolCalls![0]!.id, 'file_read', 'A'.repeat(2000)));
    }
    const before = estimator.estimateMessages(messages);
    const { result, tokensAfter, droppedSummary } = mechanicalDegrade(messages, { estimator });

    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.metadata?.source).toBe('contextLedger');
    expect(String(result[0]!.content)).toContain('Context truncated');
    expect(String(result[0]!.content)).toContain('file_read: Read file 0');
    expect(tokensAfter).toBeLessThan(before / 4);
    expect(droppedSummary).toContain('purpose ledger');
  });

  it('账本仍超预算时如实上报 overBudget（不丢条目）', () => {
    const messages = Array.from({ length: 30 }, (_, i) => {
      const call = createToolCallMessage('shell', { purpose: `Step ${i} of long plan` });
      return [call, createToolResultMessage(call.toolCalls![0]!.id, 'shell', 'r'.repeat(500))];
    }).flat();
    const { result, overBudget } = mechanicalDegrade(messages, {
      targetTokens: 1,
      estimator,
    });
    expect(overBudget).toBe(true);
    // 30 条调用全部保留在账本里——丢条目等于静默失忆
    expect(String(result[0]!.content).match(/- shell: Step/g)).toHaveLength(30);
  });
});

describe('ledgerTruncate（物理溢出兜底）', () => {
  let estimator: HeuristicTokenEstimator;

  beforeEach(() => {
    estimator = new HeuristicTokenEstimator();
  });

  it('无可丢弃时不插假「0 removed」通知', () => {
    const messages = [
      createMessage('user', 'a'),
      createMessage('assistant', 'b'),
      createMessage('user', 'c'),
    ];
    const { result, droppedCount } = ledgerTruncate(messages, { targetTokens: 1, estimator });
    expect(droppedCount).toBe(0);
    expect(result).toHaveLength(3);
    expect(result.every((m) => !String(m.content).includes('0 earlier messages removed'))).toBe(
      true,
    );
  });

  it('超预算时从头丢弃到保底，插账本说明（user + contextLedger）', () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i} with some content`)
    );

    const { result, droppedCount } = ledgerTruncate(messages, { targetTokens: 50, estimator });

    expect(droppedCount).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(messages.length + 1);
    // 首条应为 user 角色账本说明（避免中段 system）
    expect(result[0].role).toBe('user');
    expect(result[0].metadata?.source).toBe('contextLedger');
    expect(String(result[0].content)).toContain('Context truncated');
  });

  it('tool_call/tool_result 对同进同出：保留尾不起于孤儿结果', () => {
    const messages: Message[] = [createMessage('user', 'go')];
    for (let i = 0; i < 8; i++) {
      messages.push(createToolCallMessage(`t${i}`, { i }));
      messages.push(createToolResultMessage(`call_${i}`, `t${i}`, `r${i} ` + 'x'.repeat(200)));
    }
    const { result } = ledgerTruncate(messages, { targetTokens: 20, estimator });
    // 首条是账本说明；其后第一条保留消息不得是孤儿 tool 结果
    const firstKept = result[1];
    expect(firstKept?.role).not.toBe('tool');
    expect(firstKept?.toolResults?.length ?? 0).toBe(0);
  });

  it('连续 tool 结果收尾：孤儿边界回退切点，kept 不清空（宁可胖，不可拆对）', () => {
    const messages: Message[] = [
      createMessage('user', 'go'),
      createToolCallMessage('t1', { i: 1 }),
      createToolResultMessage('call_1', 't1', 'r1'),
      createToolCallMessage('t2', { i: 2 }),
      createToolResultMessage('call_2', 't2', 'r2'),
      createToolResultMessage('call_2b', 't2', 'r3'),
    ];
    const { result, droppedCount } = ledgerTruncate(messages, {
      targetTokens: 1,
      estimator,
      minKeep: 2,
    });
    // 回退而非向前吞光：kept 起于 assistant（对完整），且不少于保底
    const kept = result.slice(1);
    expect(droppedCount).toBeGreaterThan(0);
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(kept[0]?.role).not.toBe('tool');
  });

  it('minKeep 为纯保底（不叠 15%）：长列表保 2 就是 2', () => {
    const messages = Array.from({ length: 50 }, (_, i) => createMessage('user', `m${i}`));
    const { result } = ledgerTruncate(messages, {
      targetTokens: 1,
      estimator,
      minKeep: 2,
    });
    // notice + 恰 2 条近尾（15% 口径会留 8——minKeep 必须压住 15%）
    expect(result).toHaveLength(3);
    expect(String(result[1]?.content)).toContain('m48');
    expect(String(result[2]?.content)).toContain('m49');
  });

  it('丢弃段的账本只留 name + purpose（占位常量单源）', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 12; i++) {
      const call = createToolCallMessage('shell', { purpose: `Cmd ${i}` });
      messages.push(call);
      messages.push(createToolResultMessage(call.toolCalls![0]!.id, 'shell', 'x'.repeat(300)));
    }
    const { result, ledgerKept } = ledgerTruncate(messages, { targetTokens: 20, estimator });
    expect(ledgerKept).toBe(true);
    expect(String(result[0]!.content).startsWith(MECHANICAL_NOTICE_TRUNCATED)).toBe(true);
    expect(String(result[0]!.content)).toContain('shell: Cmd 0');
    // 结果正文不进账本
    expect(String(result[0]!.content)).not.toContain('x'.repeat(100));
  });
});

describe('alignViewSplit（P3 切片手术单源）', () => {
  const msgs = (): Message[] => [
    createMessage('user', 'u0'),
    createToolCallMessage('t0', { i: 0 }),
    createToolResultMessage('c0', 't0', 'r0'),
    createMessage('user', 'u1'),
    createToolCallMessage('t1', { i: 1 }),
    createToolResultMessage('c1', 't1', 'r1'),
  ];
  it('tailCount=0 → 空尾且不越界读 messages[len]', () => {
    expect(alignViewSplit(msgs(), 1, 0)).toEqual({ headEnd: 1, tailStart: 6 });
  });
  it('head 回退：裸切点停在带 toolCalls 的 assistant 上时退到其前', () => {
    expect(alignViewSplit(msgs(), 2, 1).headEnd).toBe(1);
  });
  it('tail 回退：裸起点落在 tool 结果上时退到其调用', () => {
    expect(alignViewSplit(msgs(), 0, 1).tailStart).toBe(4);
  });
  it('protect 总和超过长度时夹回合法切点（head/tail 不重叠）', () => {
    const { headEnd, tailStart } = alignViewSplit(msgs(), 6, 6);
    expect(headEnd).toBeLessThanOrEqual(tailStart);
    expect(tailStart).toBe(6);
  });
});

// ── BudgetAllocator 测试（不变量驱动） ──

describe('DefaultBudgetAllocator', () => {
  let allocator: DefaultBudgetAllocator;

  beforeEach(() => {
    allocator = new DefaultBudgetAllocator();
  });

  /** 不变量：输入上限 + 输出预留 ≤ 生效窗口，且消息限额不超过输入上限扣除固定开销 */
  const assertInvariant = (
    r: { inputLimit: number; messagesLimit: number; outputReserve: number },
    limit: number,
    fixed: number,
  ): void => {
    expect(r.inputLimit + r.outputReserve).toBeLessThanOrEqual(limit);
    expect(r.messagesLimit + fixed).toBeLessThanOrEqual(r.inputLimit);
  };

  it('窗口已知：输出预留取模型 maxOutputTokens（硬预留，不打折）', () => {
    const result = allocator.allocate({
      tokenBudget: 1_048_576,
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      systemPromptTokens: 10_467,
      toolTokens: 12_000,
    });
    expect(result.outputReserve).toBe(131_072);
    expect(result.inputLimit).toBe(1_048_576 - 131_072);
    assertInvariant(result, 1_048_576, 10_467 + 12_000 + 500);
  });

  it('maxOutputTokens 未知时按窗口比例回退（保持历史行为）', () => {
    const result = allocator.allocate({
      tokenBudget: 128_000,
      contextWindow: 128_000,
      systemPromptTokens: 6_000,
      toolTokens: 8_000,
    });
    // 128k × 20% = 25,600 → 夹到上限 8000
    expect(result.outputReserve).toBe(8_000);
    assertInvariant(result, 128_000, 6_000 + 8_000 + 500);
  });

  it('tokenBudget 与 contextWindow 取较小值', () => {
    const result = allocator.allocate({
      tokenBudget: 200_000,
      contextWindow: 128_000,
      systemPromptTokens: 1_000,
      toolTokens: 2_000,
    });
    assertInvariant(result, 128_000, 1_000 + 2_000 + 500);
  });

  it('回退路径尊重 min/max 输出预留', () => {
    const min = new DefaultBudgetAllocator({ minOutputReserve: 3_000 }).allocate({
      tokenBudget: 10_000,
      contextWindow: 10_000,
      systemPromptTokens: 1_000,
      toolTokens: 1_000,
    });
    expect(min.outputReserve).toBe(3_000);

    const max = new DefaultBudgetAllocator({ maxOutputReserve: 5_000 }).allocate({
      tokenBudget: 1_000_000,
      contextWindow: 1_000_000,
      systemPromptTokens: 1_000,
      toolTokens: 1_000,
    });
    expect(max.outputReserve).toBe(5_000);
  });

  it('物理窗口放不下固定开销+输出预留 → infeasible（不静默保底）', () => {
    const result = allocator.allocate({
      tokenBudget: 100,
      contextWindow: 100,
      maxOutputTokens: 90,
      systemPromptTokens: 50,
      toolTokens: 50,
    });
    expect(result.infeasible).toBe(true);
    expect(result.messagesLimit).toBe(0);
  });

  it('仅有策略目标（无物理窗口）时保底继续，不报不可行', () => {
    const result = allocator.allocate({
      tokenBudget: 100,
      systemPromptTokens: 50,
      toolTokens: 50,
    });
    expect(result.infeasible).toBeUndefined();
    expect(result.messagesLimit).toBeGreaterThanOrEqual(1000);
  });
});

// ── DefaultContextEngine 测试 ──

describe('DefaultContextEngine', () => {
  let engine: ContextEngine;
  let estimator: HeuristicTokenEstimator;

  beforeEach(() => {
    engine = new DefaultContextEngine();
    estimator = new HeuristicTokenEstimator();
  });

  describe('info', () => {
    it('should have correct info', () => {
      expect(engine.info.id).toBe('default');
      expect(engine.info.name).toBe('Default Context Engine');
    });
  });

  describe('assemble', () => {
    it('should assemble messages within budget', async () => {
      const messages = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi there!'),
      ];

      const result = await engine.assemble({
        sessionId: 'test',
        messages,
        systemPrompt: 'You are a helpful assistant.',
        tools: [],
        tokenBudget: 100000,
      });

      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.estimatedTokens).toBeGreaterThan(0);
      expect(result.systemPrompt).toBe('You are a helpful assistant.');
    });

    it('should include system prompt', async () => {
      const messages = [createMessage('user', 'Hello')];

      const result = await engine.assemble({
        sessionId: 'test',
        messages,
        systemPrompt: 'You are a test assistant.',
        tools: [],
        tokenBudget: 100000,
      });

      // First message should be system
      expect(result.messages[0].role).toBe('system');
      expect(result.messages[0].content).toBe('You are a test assistant.');
    });

    it('should include tool definitions in token calculation', async () => {
      const messages = [createMessage('user', 'Hello')];
      const tools = [
        createToolDefinition('read_file', 'Read a file'),
        createToolDefinition('write_file', 'Write a file'),
      ];

      const result = await engine.assemble({
        sessionId: 'test',
        messages,
        systemPrompt: 'You are a helpful assistant.',
        tools,
        tokenBudget: 100000,
      });

      expect(result.estimatedTokens).toBeGreaterThan(0);
    });

    it('should compress when over budget', async () => {
      const messages = Array.from({ length: 50 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i} with some content to fill the context window`)
      );

      const result = await engine.assemble({
        sessionId: 'test',
        messages,
        systemPrompt: 'You are a helpful assistant.',
        tools: [],
        tokenBudget: 2000, // Small budget
      });

      // Should have fewer messages than original (including system prompt)
      expect(result.messages.length).toBeLessThanOrEqual(messages.length + 1);
    });

    it('should provide dropped summary when compressed', async () => {
      const messages = Array.from({ length: 50 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i} with some content`)
      );

      const result = await engine.assemble({
        sessionId: 'test',
        messages,
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 500, // Very small budget
      });

      if (result.droppedSummary) {
        expect(result.droppedSummary.length).toBeGreaterThan(0);
      }
    });

    it('should use summarize function when provided', async () => {
      const messages = Array.from({ length: 30 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i} with some content to make it longer`)
      );

      const mockSummarize: SummarizeFunction = vi.fn().mockResolvedValue('Summary of conversation');

      const result = await engine.assemble({
        sessionId: 'test-summarize',
        messages,
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 2000, // Small budget to trigger compression
        summarize: mockSummarize,
      });

      // Should have compressed messages
      expect(result.messages.length).toBeLessThanOrEqual(messages.length + 1);
    });

    it('should handle empty messages', async () => {
      const result = await engine.assemble({
        sessionId: 'test',
        messages: [],
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 100000,
      });

      // Should have only system prompt
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].role).toBe('system');
    });

    it('should convert messages to LLM format', async () => {
      const messages = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi!'),
      ];

      const result = await engine.assemble({
        sessionId: 'test',
        messages,
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 100000,
      });

      // Check LLM message format
      for (const msg of result.messages) {
        expect(msg.role).toBeDefined();
        if (typeof msg.content === 'string') {
          expect(typeof msg.content).toBe('string');
        }
      }
    });
  });

  describe('afterStep', () => {
    it('should update state after turn', async () => {
      // First assemble to create state
      await engine.assemble({
        sessionId: 'test',
        messages: [createMessage('user', 'Hello')],
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 100000,
      });

      // Should not throw
      await engine.afterStep!({
        sessionId: 'test',
        step: [createMessage('assistant', 'Response')],
        usage: makeTokenUsage({ promptTokens: 100, completionTokens: 50 }),
      });
    });

    it('should calibrate token estimates using real usage', async () => {
      // First assemble to create state with known estimate
      const result1 = await engine.assemble({
        sessionId: 'calibrate-test',
        messages: [createMessage('user', 'Hello world')],
        systemPrompt: 'Test prompt',
        tools: [],
        tokenBudget: 100000,
      });
      const firstEstimate = result1.estimatedTokens;

      // afterStep with real usage that's 2x the estimate
      await engine.afterStep!({
        sessionId: 'calibrate-test',
        step: [createMessage('assistant', 'Response')],
        usage: makeTokenUsage({ promptTokens: firstEstimate * 2, completionTokens: 50 }),
      });

      // Second assemble should use calibrated estimate
      const result2 = await engine.assemble({
        sessionId: 'calibrate-test',
        messages: [createMessage('user', 'Hello world')],
        systemPrompt: 'Test prompt',
        tools: [],
        tokenBudget: 100000,
      });

      // Calibrated estimate should be higher than raw estimate
      // （首个样本：0.7×2 + 0.3×1 = 1.7×，EMA 新旧权重 0.7/0.3）
      expect(result2.estimatedTokens).toBeGreaterThan(firstEstimate);
    });

    it('clamps calibration ratio at 4.0 with out-of-bounds warn (no silent 2.0 cap)', async () => {
      // Assemble to create state
      await engine.assemble({
        sessionId: 'clamp-test',
        messages: [createMessage('user', 'Test')],
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 100000,
      });

      // afterStep with extremely high usage (100x)
      await engine.afterStep!({
        sessionId: 'clamp-test',
        step: [createMessage('assistant', 'Response')],
        usage: makeTokenUsage({ promptTokens: 100000, completionTokens: 50 }),
      });

      // Should not throw and should produce reasonable result
      const result = await engine.assemble({
        sessionId: 'clamp-test',
        messages: [createMessage('user', 'Test')],
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 100000,
      });

      // P1-a：clamp 放宽至 [0.25, 4.0] 且越界告警不再静默——100× 样本夹到 4.0 入平滑
      // （首样本 0.7*4.0 + 0.3*1.0 = 3.1），读数不再被旧 2.0 封顶
      const rawEstimate = estimator.estimateMessages([createMessage('user', 'Test')])
        + estimator.estimateText('Test') + 12; // message overhead
      expect(result.estimatedTokens).toBeGreaterThan(rawEstimate * 2.5);
      expect(result.estimatedTokens).toBeLessThanOrEqual(rawEstimate * 3.2); // EMA 3.1 + rounding slack
    });

    it('decision readings shift with learned ratio (selector overflow boundary, R1)', () => {
      const ledger = new ContextSizeLedger(() => {});
      const raw = new HeuristicTokenEstimator();
      const selector = new DefaultMessageSelector();
      const messages = Array.from({ length: 10 }, (_, i) => createMessage('user', `Message content ${i}`));
      const opts = { maxTokens: 200, protectFirstN: 0, protectLastN: 0 };
      const base = selector.select(messages, opts, raw);
      // 学到 1.7× 后同一预算下溢出面必须变大（决策读数随校准移动，而非只动展示）
      ledger.observe('mock/m', 200, 100);
      const calibrated = selector.select(messages, opts, ledger.calibratedEstimator('mock/m', raw));
      expect(calibrated.overflow.length).toBeGreaterThan(base.overflow.length);
    });

    it('compact-only rounds never write lastEstimatedTokens (single-writer invariant)', async () => {
      const engine2 = new DefaultContextEngine();
      await engine2.assemble({
        sessionId: 'sw-test',
        modelKey: 'mock/m',
        messages: [createMessage('user', 'hello world')],
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 100000,
      });
      const states = (
        engine2 as unknown as { states: Map<string, { lastEstimatedTokens?: number; modelKey?: string }> }
      ).states;
      const stateKey = [...states.keys()][0];
      const before = states.get(stateKey)!.lastEstimatedTokens;
      expect(before).toBeGreaterThan(0);

      // manual 压缩轮（无 summarize → 机械路径）：只动压缩态，不得触碰校准基 / modelKey
      await (
        engine2 as unknown as { compactStructural: (i: Record<string, unknown>) => Promise<unknown> }
      ).compactStructural({
        sessionId: 'sw-test',
        messages: [createMessage('user', 'hello world'), createMessage('user', 'more content here')],
      });
      const after = states.get(stateKey)!;
      expect(after.lastEstimatedTokens).toBe(before);
      expect(after.modelKey).toBe('mock/m');
    });
  });

  describe('ingest', () => {
    it('should be a no-op', async () => {
      // Should not throw
      await engine.ingest!({
        sessionId: 'test',
        message: createMessage('user', 'Hello'),
      });
    });
  });
});

// ── SmartRouter 测试 ──

describe('Q2 B′ 连线', () => {
  it('工具胖溢出出真摘要：不再「只打码不摘要」', async () => {
    // 旧 truncate_tool_results_only 触发面：工具结果冗长 + 溢出 + 有 summarize。
    // 关掉主动压缩隔离溢出路；旧实现 0ms 静默打码，B′ 后必须发真摘要并进视图。
    // 胖结果必须落在**旧**区（选择器保留最近段，溢出的是最旧消息）。
    const messages: Message[] = [createMessage('user', 'go')];
    for (let i = 0; i < 6; i++) {
      messages.push(createToolCallMessage('read_file', { path: `/f${i}` }));
      messages.push(createToolResultMessage(`call_${i}`, 'read_file', 'R'.repeat(3000)));
    }
    messages.push(createMessage('user', 'wrap up'));
    const summarize = vi.fn().mockResolvedValue('SUMMARIZED-HANDOFF');
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 1,
      targetTokens: 0,
      proactiveCompactRatio: 0,
    });
    const result = await engine.assemble({
      sessionId: 'bp-wire',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      // 窗口须放得下摘要请求（prefix≈全史+max_tokens）；窗口小于全史时是
      // 窗口守卫的如实失败→机械降级场景（另一行为，勿混进本钉）
      contextWindow: 32000,
      summarize,
    });
    expect(summarize).toHaveBeenCalled();
    const text = JSON.stringify(result.messages);
    expect(text).toContain('SUMMARIZED-HANDOFF');
    // 有 summarize 时不得以机械账本冒充压缩结果
    expect(text).not.toContain(MECHANICAL_NOTICE_TRUNCATED);
  });
});

describe('before_compaction deny 的 overflow 下游语义', () => {
  it('拒绝压缩不逼出超窗请求：机械截断兜底 + kind:denied + start/end 配对', async () => {
    const messages: Message[] = [createMessage('user', 'go')];
    for (let i = 0; i < 6; i++) {
      messages.push(createToolCallMessage('read_file', { path: `/f${i}` }));
      messages.push(createToolResultMessage(`call_${i}`, 'read_file', 'R'.repeat(3000)));
    }
    messages.push(createMessage('user', 'wrap up'));
    const events: Array<{ type: string; kind?: string }> = [];
    const summarize = vi.fn();
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 1,
      targetTokens: 0,
      proactiveCompactRatio: 0,
      compactEngine: {
        compactMessages: async () => ({
          ok: true, compacted: false, fresh: false, summarizeAttempted: false,
          reason: 'denied:before_compaction', tokensBefore: 0, view: [],
        }),
        compactText: async () => ({
          ok: true, compacted: false, fresh: false, summarizeAttempted: false,
          reason: 'denied:before_compaction', tokensBefore: 0, view: '',
        }),
      },
    });
    const result = await engine.assemble({
      sessionId: 'deny-overflow', messages, systemPrompt: 'sys', tools: [],
      tokenBudget: 4000, contextWindow: 32000, summarize,
      emit: (event) => { events.push(event); },
    });
    // deny 阻止摘要与状态提交，但不得把超窗请求原样发给 Provider：机械截断兜底
    expect(summarize).not.toHaveBeenCalled();
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(String(result.droppedSummary)).toContain('denied:');
    expect(String(result.droppedSummary)).toContain('truncation');
    // deny 是策略拒绝不是故障
    expect(events.find((event) => event.type === 'context.compact.error')).toMatchObject({
      type: 'context.compact.error', kind: 'denied',
    });
    // start/end 配对闭合
    expect(events.filter((event) => event.type === 'context.compact.start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'context.compact.end')).toHaveLength(1);
  });
});

describe('SmartRouter', () => {
  let router: SmartRouter;
  let estimator: HeuristicTokenEstimator;

  beforeEach(() => {
    estimator = new HeuristicTokenEstimator();
    router = new SmartRouter({ tokenEstimator: estimator });
  });

  describe('evaluate', () => {
    it('should return fits when within budget', () => {
      const messages = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi'),
      ];

      const decision = router.evaluate(messages, 100000);

      expect(decision.route).toBe('fits');
      expect(decision.shouldCompact).toBe(false);
      expect(decision.overflowTokens).toBe(0);
    });

    it('should return compact when overflow', () => {
      const messages = Array.from({ length: 50 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i} with some content`)
      );

      const decision = router.evaluate(messages, 100);

      expect(decision.route).toBe('compact');
      expect(decision.shouldCompact).toBe(true);
      expect(decision.overflowTokens).toBeGreaterThan(0);
    });

    it('工具胖溢出也走 compact（B′：弃「只打码不摘要」路由）', () => {
      // 原 truncate_tool_results_only 场景：工具结果冗长——现仍出真摘要（机械打码在降级阶梯里）
      const messages = [
        createMessage('user', 'Read files'),
        createToolCallMessage('read_file', { path: '/test.txt' }),
        createToolResultMessage('call_1', 'read_file', 'A'.repeat(5000)),
        createMessage('assistant', 'Done'),
      ];

      const decision = router.evaluate(messages, 200);

      expect(decision.route).toBe('compact');
      expect(decision.shouldCompact).toBe(true);
    });

    it('should calculate overflow tokens correctly', () => {
      const messages = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi'),
      ];

      const rawEstimatedTokens = estimator.estimateMessages(messages);
      // SmartRouter applies SAFETY_MARGIN (1.2x), so estimatedTokens is ceil(raw * 1.2)
      const expectedEstimatedTokens = Math.ceil(rawEstimatedTokens * 1.2);
      const decision = router.evaluate(messages, expectedEstimatedTokens - 10);

      expect(decision.overflowTokens).toBeGreaterThan(0);
      expect(decision.estimatedTokens).toBe(expectedEstimatedTokens);
    });
  });
});

// ── 集成测试 ──

describe('ContextEngine Integration', () => {
  it('should work end-to-end with real estimator', async () => {
    const engine = new DefaultContextEngine();
    const messages = [
      createMessage('user', 'Read the file /test.txt'),
      createToolCallMessage('read_file', { path: '/test.txt' }),
      createToolResultMessage('call_1', 'read_file', 'File contents here'),
      createMessage('assistant', 'Here are the contents: File contents here'),
      createMessage('user', 'Now write to /output.txt'),
      createToolCallMessage('write_file', { path: '/output.txt', content: 'New content' }),
      createToolResultMessage('call_2', 'write_file', 'Success'),
      createMessage('assistant', 'Done! Written to /output.txt'),
    ];

    const tools = [
      createToolDefinition('read_file', 'Read a file'),
      createToolDefinition('write_file', 'Write a file'),
    ];

    const result = await engine.assemble({
      sessionId: 'integration-test',
      messages,
      systemPrompt: 'You are a file assistant.',
      tools,
      tokenBudget: 100000,
    });

    // Should have all messages + system prompt
    expect(result.messages.length).toBe(messages.length + 1);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.systemPrompt).toBe('You are a file assistant.');
  });

  it('should handle compression with summary', async () => {
    const engine = new DefaultContextEngine();
    const messages = Array.from({ length: 100 }, (_, i) =>
      createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}: ${'x'.repeat(50)}`)
    );

    const result = await engine.assemble({
      sessionId: 'compression-test',
      messages,
      systemPrompt: 'Test',
      tools: [],
      tokenBudget: 2000, // Small budget
    });

    // Should compress
    expect(result.messages.length).toBeLessThan(messages.length + 1);
  });

  it('should maintain state across calls', async () => {
    const engine = new DefaultContextEngine();

    // First call
    await engine.assemble({
      sessionId: 'state-test',
      messages: [createMessage('user', 'Hello')],
      systemPrompt: 'Test',
      tools: [],
      tokenBudget: 100000,
    });

    // afterStep
    await engine.afterStep!({
      sessionId: 'state-test',
      step: [createMessage('assistant', 'Response')],
      usage: makeTokenUsage({ promptTokens: 100, completionTokens: 50 }),
    });

    // Second call
    const result = await engine.assemble({
      sessionId: 'state-test',
      messages: [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Response'),
        createMessage('user', 'Follow up'),
      ],
      systemPrompt: 'Test',
      tools: [],
      tokenBudget: 100000,
    });

    expect(result.messages.length).toBeGreaterThan(0);
  });

  it('tool error results must surface error text to the LLM, not null', async () => {
    const engine = new DefaultContextEngine();
    const messages: Message[] = [
      createMessage('user', 'Run the tool'),
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_err', name: 'shell', arguments: { command: 'bad' } }],
        timestamp: Date.now(),
      },
      {
        role: 'tool',
        content: '',
        // Loop 契约：失败时 result=null、error=文案
        toolResults: [{
          toolCallId: 'call_err',
          name: 'shell',
          result: null,
          error: 'command not found: bad',
        }],
        timestamp: Date.now(),
      },
    ];

    const result = await engine.assemble({
      sessionId: 'tool-error-test',
      messages,
      systemPrompt: 'Test',
      tools: [],
      tokenBudget: 100000,
    });

    const toolMsg = result.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(String(toolMsg!.content)).toContain('command not found: bad');
    expect(String(toolMsg!.content)).not.toBe('null');
  });

  it('tool success results still pass through raw content', async () => {
    const engine = new DefaultContextEngine();
    const messages: Message[] = [
      createMessage('user', 'Run the tool'),
      createToolResultMessage('call_ok', 'shell', 'exit 0'),
    ];

    const result = await engine.assemble({
      sessionId: 'tool-ok-test',
      messages,
      systemPrompt: 'Test',
      tools: [],
      tokenBudget: 100000,
    });

    const toolMsg = result.messages.find(m => m.role === 'tool');
    expect(toolMsg?.content).toBe('exit 0');
  });
});
