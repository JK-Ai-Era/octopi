/**
 * Capabilities Summary — P0 行为测试
 */

import { describe, it, expect } from 'vitest';
import type { ModelProvider, LLMRequest } from '../../../src/core/interfaces/model-provider.js';
import {
  applyL1Truncate,
  applyToolSummary,
  computeInputBudget,
  createDefaultSummaryPolicies,
  createSummaryPort,
  createToolSummarySupport,
  extractStructured,
  kindFromContentType,
  kindFromExtension,
  parseLooseJson,
  resolveKind,
  resolvePolicyForUnit,
  resolveSummaryModel,
  resolveSupportBinding,
  resolveToolBinding,
  createDefaultToolBindings,
  shouldProcessUnit,
  validateStructured,
} from '../../../src/harness/capabilities/summary/index.js';
import type { ContentUnit, SummaryPolicy } from '../../../src/harness/capabilities/summary/index.js';
import { pickSummarizeProvider } from '../../../src/harness/context/summarize.js';

function mockProvider(content = 'extracted-facts'): ModelProvider & { calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  return {
    name: 'mock',
    defaultModel: 'm',
    calls,
    async chat(req: LLMRequest) {
      calls.push(req);
      return { content, model: req.model ?? 'm', finishReason: 'stop' as const };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
    async isAvailable() {
      return true;
    },
    getModelInfo() {
      return { name: 'm', contextWindow: 32000 };
    },
    getModelInfos() {
      return [{ name: 'm', contextWindow: 32000 }];
    },
  };
}

function unit(partial: Partial<ContentUnit> & { text: string }): ContentUnit {
  return {
    channel: 'tool',
    source: {},
    ...partial,
  };
}

describe('kind routing', () => {
  it('MIME 与扩展名路由到 kind，而非 tool_output', () => {
    expect(kindFromContentType('text/html; charset=utf-8')).toBe('web_page');
    expect(kindFromContentType('application/json')).toBe('api_json');
    expect(kindFromExtension('.ts')).toBe('code');
    expect(kindFromExtension('.md')).toBe('file_text');
  });

  it('channel=tool 与 kind 分维', () => {
    const u = unit({
      text: 'x',
      channel: 'tool',
      source: { tool: 'http_request', contentType: 'text/html' },
    });
    expect(resolveKind(u)).toBe('web_page');
  });
});

describe('policy resolution', () => {
  it('kind → 预置 policy id', () => {
    const registry = createDefaultSummaryPolicies();
    const policy = resolvePolicyForUnit(
      unit({ text: 'x', source: { contentType: 'text/html' } }),
      registry,
    );
    expect(policy.id).toBe('web_page_extract');
  });

  it('整策略替换覆盖同 id', () => {
    const override: SummaryPolicy = {
      id: 'web_page_extract',
      contentKind: 'web_page',
      extract: { include: ['only-title'], exclude: [] },
      preserve: [],
      budget: { maxInputTokens: 1000, maxOutputTokens: 100 },
      output: 'text',
      oversized: { strategy: 'window' },
    };
    const port = createSummaryPort({
      providers: new Map(),
      fallbackProvider: mockProvider(),
      policyOverrides: { web_page_extract: override },
    });
    const p = port.resolvePolicy(unit({ text: '<html/>', source: { contentType: 'text/html' } }));
    expect(p.extract.include).toEqual(['only-title']);
  });
});

describe('model resolve chain', () => {
  const main = mockProvider();
  main.name = 'main';
  const cheap = mockProvider();
  cheap.name = 'cheap';

  it('优先 models.level.summary', () => {
    const r = resolveSummaryModel({
      providers: new Map([
        ['cheap', cheap],
        ['main', main],
      ]),
      levelMap: {
        summary: { primary: 'cheap/sum-model' },
        mini: { primary: 'main/mini-model' },
      },
      fallbackProvider: main,
    });
    expect(r.from).toBe('level.summary');
    expect(r.provider).toBe(cheap);
    expect(r.model).toBe('sum-model');
  });

  it('无 summary 档时走 mini', () => {
    const r = resolveSummaryModel({
      providers: new Map([['main', main]]),
      levelMap: { mini: { primary: 'main/mini-model' } },
      fallbackProvider: main,
    });
    expect(r.from).toBe('mini');
  });

  it('pickSummarizeProvider 优先 summary 档', () => {
    const picked = pickSummarizeProvider(
      new Map([['cheap', cheap]]),
      {
        summary: { primary: 'cheap/sum' },
        mini: { primary: 'cheap/mini' },
      },
      main,
    );
    expect(picked.provider).toBe(cheap);
    expect(picked.model).toBe('sum');
  });
});

describe('gate and L1', () => {
  it('shouldProcess 低于双阈值为 false', () => {
    expect(
      shouldProcessUnit(unit({ text: 'short' }), { minTokens: 100, minBytes: 1000 }),
    ).toBe(false);
  });

  it('L1 超硬顶：总长不超过 maxChars 且含续读提示', () => {
    const r = applyL1Truncate('a'.repeat(100), 80, 'use offset/limit');
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(80);
    expect(r.text).toContain('use offset/limit');
    expect(r.text).toMatch(/first \d+ of 100/);
  });

  it('L1 极小 maxChars 时仍不超硬顶', () => {
    const r = applyL1Truncate('a'.repeat(100), 10, 'use offset/limit');
    expect(r.text.length).toBeLessThanOrEqual(10);
    expect(r.truncated).toBe(true);
  });
});

describe('structured L0/L1', () => {
  const policy: SummaryPolicy = {
    id: 't',
    contentKind: 'api_json',
    extract: { include: [], exclude: [] },
    preserve: [],
    budget: { maxInputTokens: 1000, maxOutputTokens: 100 },
    output: 'structured_json',
    fields: ['title', 'url'],
    fieldTypes: { title: 'string' },
    oversized: { strategy: 'window' },
  };

  it('宽松解析取出 JSON 对象', () => {
    const r = parseLooseJson('Here you go:\n```json\n{"a":1}\n```');
    expect(r.structured).toEqual({ a: 1 });
  });

  it('缺 fields 时写 structuredError，不静默成功', () => {
    const r = extractStructured('{"title":"only"}', policy);
    expect(r.structured).toBeUndefined();
    expect(r.structuredError).toContain('missing fields');
  });

  it('类型不符时 contract 失败', () => {
    const r = extractStructured('{"title":123,"url":"u"}', policy);
    expect(r.structuredError).toContain('type mismatch');
  });

  it('字段齐全时通过', () => {
    const r = extractStructured('{"title":"t","url":"u"}', policy);
    expect(r.structured).toEqual({ title: 't', url: 'u' });
  });

  it('validateStructured 根类型错误', () => {
    const r = validateStructured([1, 2], policy);
    expect(r.structuredError).toContain('root must be object');
  });
});

describe('applyToolSummary L1/L2', () => {
  const provider = mockProvider('clean-body');

  it('code file_read 默认不 L2，但 L1 仍生效', async () => {
    const provider2 = mockProvider('clean-body');
    const port = createSummaryPort({
      providers: new Map([['mock', provider2]]),
      fallbackProvider: provider2,
    });
    const binding = resolveToolBinding(
      'file_read',
      createDefaultToolBindings(),
      { file_read: { maxReturnChars: 200 } },
      200,
    );
    const big = 'export const x = 1;\n'.repeat(100);
    const out = await applyToolSummary({
      tool: 'file_read',
      rawBody: big,
      support: { port, binding },
      extension: '.ts',
      truncateHint: 'offset/limit',
    });
    expect(out.summary?.applied).not.toBe(true);
    expect(out.bodyTruncated).toBe(true);
    expect(out.body.length).toBeLessThanOrEqual(200);
    expect(out.body).toContain('offset/limit');
  });

  it('http 超 gate 走 L2', async () => {
    const port = createSummaryPort({
      providers: new Map([['mock', provider]]),
      fallbackProvider: provider,
      gate: { minTokens: 10, minBytes: 20 },
    });
    const binding = resolveToolBinding('http_request', createDefaultToolBindings(), undefined, 8000);
    const html = '<html>' + 'ad noise '.repeat(200) + '<main>facts</main></html>';
    const out = await applyToolSummary({
      tool: 'http_request',
      rawBody: html,
      support: { port, binding },
      contentType: 'text/html',
      truncateHint: 'narrower url',
    });
    expect(out.summary?.applied).toBe(true);
    expect(out.body).toContain('clean-body');
    expect(provider.calls.length).toBeGreaterThan(0);
  });

  it('summarize=off 仍 L1，不倾倒全文', async () => {
    const port = createSummaryPort({
      providers: new Map([['mock', provider]]),
      fallbackProvider: provider,
      gate: { minTokens: 1, minBytes: 1 },
    });
    const binding = resolveToolBinding(
      'http_request',
      createDefaultToolBindings(),
      { http_request: { maxReturnChars: 40 } },
      40,
    );
    const out = await applyToolSummary({
      tool: 'http_request',
      rawBody: 'z'.repeat(200),
      support: { port, binding },
      summarizeArg: 'off',
      truncateHint: 'hint',
    });
    expect(out.summary?.skipReason).toBe('summarize_off');
    expect(out.bodyTruncated).toBe(true);
    expect(out.body.length).toBeLessThan(200);
  });
});

describe('budget', () => {
  it('未知窗口使用 defaultInputBudgetTokens', () => {
    const policy = createDefaultSummaryPolicies()['web_page_extract']!;
    const b = computeInputBudget({
      policy,
      defaultInputBudgetTokens: 1000,
      safetyMarginTokens: 100,
    });
    expect(b).toBeLessThanOrEqual(1000);
    expect(b).toBeGreaterThan(0);
  });

  it('有 catalog contextWindow 时预算吃窗口（含 maxOutputTokens）', () => {
    const policy = createDefaultSummaryPolicies()['web_page_extract']!;
    const b = computeInputBudget({
      policy,
      contextWindow: 50_000,
      defaultInputBudgetTokens: 24_000,
      safetyMarginTokens: 2_000,
      systemPromptTokens: 0,
    });
    // min(policy.maxInput=24000, window-out-margin=50000-2000-2000=46000) = 24000
    expect(b).toBe(24_000);
    const b2 = computeInputBudget({
      policy: { ...policy, budget: { ...policy.budget, maxInputTokens: 100_000, maxOutputTokens: 0 } },
      contextWindow: 50_000,
      defaultInputBudgetTokens: 24_000,
      safetyMarginTokens: 2_000,
    });
    expect(b2).toBe(48_000);
  });
});

describe('config toolBindings 接线（根因：配置与 tools 同源）', () => {
  it('resolveSupportBinding 读取 toolBindings 覆盖 maxReturnChars', () => {
    const support = {
      toolBindings: { http_request: { maxReturnChars: 42 } },
      maxReturnCharsDefault: 8000,
    };
    const binding = resolveSupportBinding('http_request', support, 8000);
    expect(binding.maxReturnChars).toBe(42);
  });

  it('applyToolSummary 使用 support.toolBindings 而非写死默认', async () => {
    const provider = mockProvider('ok');
    const port = createSummaryPort({
      providers: new Map([['mock', provider]]),
      fallbackProvider: provider,
    });
    const support = createToolSummarySupport(port, {
      toolBindings: { http_request: { maxReturnChars: 30 } },
      maxReturnCharsDefault: 8000,
    });
    const out = await applyToolSummary({
      tool: 'http_request',
      rawBody: 'z'.repeat(200),
      support,
      summarizeArg: 'off',
      truncateHint: 'hint',
    });
    expect(out.bodyTruncated).toBe(true);
    expect(out.body.length).toBeLessThanOrEqual(30);
  });
});

describe('L1 硬顶含 hint', () => {
  it('最终 body 长度不超过 maxChars', () => {
    const r = applyL1Truncate('a'.repeat(500), 40, 'use offset/limit');
    expect(r.text.length).toBeLessThanOrEqual(40);
  });
});

describe('oversized fail / coverage', () => {
  it('strategy=fail 且输入超预算时 extract 抛错', async () => {
    const provider = mockProvider('x');
    provider.getModelInfo = () => null; // 未知窗口，走 defaultInputBudgetTokens
    const port = createSummaryPort({
      providers: new Map([['mock', provider]]),
      fallbackProvider: provider,
      defaultInputBudgetTokens: 100,
      safetyMarginTokens: 0,
      policyOverrides: {
        web_page_extract: {
          ...createDefaultSummaryPolicies()['web_page_extract']!,
          budget: { maxInputTokens: 200, maxOutputTokens: 50 },
          oversized: { strategy: 'fail' },
        },
      },
    });
    const big = 'word '.repeat(5000);
    await expect(
      port.extract({
        text: big,
        channel: 'tool',
        source: { contentType: 'text/html' },
      }),
    ).rejects.toThrow(/strategy=fail|oversized/);
  });

  it('oversizedStrategy 部署级覆盖 policy.strategy', () => {
    const provider = mockProvider('x');
    const port = createSummaryPort({
      providers: new Map([['mock', provider]]),
      fallbackProvider: provider,
      oversizedStrategy: 'window',
    });
    const policy = port.resolvePolicy({
      text: 'x',
      channel: 'tool',
      source: { contentType: 'text/html' },
    });
    expect(policy.oversized.strategy).toBe('window');
  });
});

describe('structured 宽松解析：不平衡括号后继续扫描', () => {
  it('噪声括号后仍能取出合法 JSON', () => {
    const r = parseLooseJson('note { broken\nreal {"a":1}');
    expect(r.structured).toEqual({ a: 1 });
  });
});
