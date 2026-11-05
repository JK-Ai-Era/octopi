/**
 * P1-c 红线：估算器统一（单实现 + 两 adapter）
 *
 * 1. 同内容两入口（领域 Message / provider LLMMessage）读数一致，差 < 1%；
 *    fixture 用**引擎实际转换后的形态**（role:'tool' 消息、image_url 块）——
 *    评审曾用 fixture 盲区藏住 image_url 0 计与逐消息取整漂移。
 * 2. 分类查表行为（text_cjk 1、text_ascii 4、tool_result 2、json 3）；
 * 3. R4：未知块按载荷长度计，不得返回常数兜底（旧「return 10」）；
 * 4. 旧缺陷回归：tool_use / tool_result 块不得塌到常数（LLM 口径）；
 *    CJK 工具结果不得按「2 token/字」高倍（领域口径膨胀 hack 误乘）。
 */
import { describe, it, expect } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import {
  HeuristicTokenEstimator,
  estimateLLMMessages,
  fromDomainMessages,
  fromLlmMessages,
} from '@octopi-agent/engine/harness/context/token-estimator.js';
import {
  estimateSegments,
  classifyChars,
  CHARS_PER_TOKEN_BY_KIND,
} from '@octopi-agent/engine/harness/context/token-segments.js';
import { estimateContentBlock } from '@octopi-agent/engine/harness/context/token-estimate-fns.js';

const estimator = new HeuristicTokenEstimator();

/**
 * 同一语义内容的两种形状表示——贴生产形态：
 * - 领域侧：toolResults 挂在 role:'tool' 消息（Loop 写历史的真实形态，可并列多条）；
 * - LLM 侧：convertMessage 的真实产物——每条 toolResult 一条 role:'tool' 消息、
 *   图像为 image_url 块（不是 image）。
 */
function dualShapes(): { domain: Message[]; llm: LLMMessage[] } {
  const domain: Message[] = [
    { role: 'user', content: 'hello world, please read the file', timestamp: 1 },
    {
      role: 'assistant',
      content: '',
      timestamp: 2,
      toolCalls: [
        { id: 't1', name: 'read_file', arguments: { path: '/tmp/a.txt' } },
        { id: 't2', name: 'stat_file', arguments: { path: '/tmp/a.txt' } },
      ],
    },
    {
      // 并列工具结果：convertMessage 发成 2 条 role:'tool' 消息（各带一条开销）
      role: 'tool',
      content: '',
      timestamp: 3,
      toolResults: [
        { toolCallId: 't1', name: 'read_file', result: { ok: true, body: '文件内容 file contents here' } },
        { toolCallId: 't2', name: 'stat_file', result: { ok: true, size: 1234 } },
      ],
    },
    { role: 'user', content: '这是中文内容，测试 CJK 计数', timestamp: 4 },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'an image follows' },
        { type: 'image' },
      ] as never,
      timestamp: 5,
    },
  ];
  const llm: LLMMessage[] = [
    { role: 'user', content: 'hello world, please read the file' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' } },
        { id: 't2', type: 'function', function: { name: 'stat_file', arguments: '{"path":"/tmp/a.txt"}' } },
      ],
    },
    // convertMessage 产物：每条 toolResult 一条 role:'tool' 消息
    { role: 'tool', content: '{"ok":true,"body":"文件内容 file contents here"}', tool_call_id: 't1', name: 'read_file' },
    { role: 'tool', content: '{"ok":true,"size":1234}', tool_call_id: 't2', name: 'stat_file' },
    { role: 'user', content: '这是中文内容，测试 CJK 计数' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'an image follows' },
        // convertMessage 产物：image_url 块（旧 fixture 用 image 块藏住了 0 计缺陷）
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
  ];
  return { domain, llm };
}

describe('P1-c estimator unification (single core, two adapters)', () => {
  it('same content via both entries: readings differ < 1% (converted shapes)', () => {
    const { domain, llm } = dualShapes();
    const domainTotal = estimator.estimateMessages(domain);
    const llmTotal = estimateLLMMessages(llm);
    expect(domainTotal).toBeGreaterThan(0);
    const diffPct = Math.abs(domainTotal - llmTotal) / Math.max(domainTotal, llmTotal);
    expect(diffPct).toBeLessThan(0.01);
  });

  it('adapters normalize to equivalent Segment shapes (kind multisets match)', () => {
    const { domain, llm } = dualShapes();
    // overhead 以 count 聚合（domain 侧 N 结果 = 1 段 count=N；LLM 侧 N 段 count=1）——
    // 比较前展开计数，比「种类多重集」而非段数
    const expand = (segs: ReturnType<typeof fromDomainMessages>): string[] =>
      segs
        .flatMap((s) => (s.kind === 'message_overhead' ? Array(s.count).fill(s) : [s]))
        .map((s) => s.kind)
        .sort();
    expect(expand(fromDomainMessages(domain))).toEqual(expand(fromLlmMessages(llm)));
  });

  it('rounding is shape-independent: single ceil over the total (评审 #3)', () => {
    // 逐消息取整会让 2×6 字符消息读 28、单消息读 27；统一总量取整后必须一致
    const twoMsgs = [user('aaaaaa'), user('bbbbb')];
    const oneMsg = [user('aaaaaabbbbb')];
    const a = estimator.estimateMessages(twoMsgs);
    const b = estimateLLMMessages([
      { role: 'user', content: 'aaaaaa' },
      { role: 'user', content: 'bbbbb' },
    ]);
    expect(a).toBe(b);
    expect(estimator.estimateMessages(oneMsg)).toBeLessThan(a); // 少一条消息开销
  });

  it('parallel toolResults overhead matches wire shape (评审 #4): N results → N×overhead', () => {
    const { domain, llm } = dualShapes();
    const dToolPart = fromDomainMessages(domain).filter((s) => s.kind === 'message_overhead');
    const lToolPart = fromLlmMessages(llm).filter((s) => s.kind === 'message_overhead');
    // 领域 3 条消息：1 + 1 + 2（toolResults×2）= 4 条开销；LLM 6 条消息 = 6 条
    const dSum = dToolPart.reduce((x, s) => x + (s as { count: number }).count, 0);
    const lSum = lToolPart.length;
    expect(dSum).toBe(lSum);
  });

  it('image_url blocks cost the same as image blocks (评审 #2)', () => {
    expect(estimateContentBlock({ type: 'image_url' })).toBe(estimateContentBlock({ type: 'image' }));
    expect(estimateContentBlock({ type: 'image_url' })).toBeGreaterThan(1000);
  });

  it('category table: pure CJK text ≈ 1 token/char, pure ascii ≈ 1/4', () => {
    const cjk = estimateSegments([{ kind: 'text', chars: 100, cjk: 100 }]);
    expect(cjk).toBe(100);
    const ascii = estimateSegments([{ kind: 'text', chars: 400, cjk: 0 }]);
    expect(ascii).toBe(100);
  });

  it('CJK tool results count at 1 token/char (old inflation-hack over-count fixed)', () => {
    // 旧口径：adjustedChars=(chars+3cjk)/2 → 全 CJK 2 token/字（100 字=200）；新口径=100
    const seg = estimateSegments([{ kind: 'tool_result', chars: 100, cjk: 100, isError: false }]);
    expect(seg).toBe(100);
    expect(seg).toBeLessThan(150);
  });

  it('LLM entry tool_use/tool_result blocks no longer collapse to constant 10', () => {
    const args = JSON.stringify({ path: '/tmp/a.txt', recursive: true, depth: 3 });
    const llm: LLMMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: JSON.parse(args) }],
      },
    ];
    const total = estimateLLMMessages(llm);
    // 旧口径：10（常数兜底）+ overhead 12 = 22；新口径 args 按 json 比率 ≈ 55/3 + 12 + name
    expect(total).toBeGreaterThan(30);
  });

  it('R4: unknown content block counts by payload length, never a constant', () => {
    const small = estimateContentBlock({ type: 'thinking', text: 'abc' });
    const large = estimateContentBlock({ type: 'thinking', text: 'x'.repeat(300) });
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
    // 无正文未知块按指针字段长度计（评审 #9：不得静默 0）
    expect(estimateContentBlock({ type: 'file', name: 'report.pdf', url: 'https://x/y.pdf' })).toBeGreaterThan(0);
    expect(estimateContentBlock({ type: 'thinking', text: '中文推理内容计数走 CJK 口径' })).toBeGreaterThan(8);
  });

  it('classifyChars: CJK extension B/G count as CJK code points (1 char, 1 token)', () => {
    const extB = '\uD840\uDC00'; // U+20000
    const extG = '\uD880\uDC00'; // U+30000（扩展 G，旧正则漏认）
    for (const ch of [extB, extG]) {
      const { chars, cjk } = classifyChars(ch);
      expect(chars).toBe(1);
      expect(cjk).toBe(1);
    }
    expect(CHARS_PER_TOKEN_BY_KIND.text_cjk).toBe(1);
  });
});

function user(content: string): Message {
  return { role: 'user', content, timestamp: 1 };
}
