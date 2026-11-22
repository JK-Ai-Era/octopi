/**
 * file_read 图像结果老化 + token 估算核对（P4）测试
 *
 * 覆盖 arch/file-read-image-view.md §2.5 + §5：
 * - 图像读取老化为 `[aged] image read` 定位指针，不保留 base64（信封随整体改写消失）
 * - 图像分支先于摘要豁免（both 模式已摘要结果也丢信封）
 * - 不膨胀守卫：老化指针短于结果正文
 * - token 估算：信封图像块计入（此前漏计 = 估算面/wire 面读数漂移）
 * - 同形红线：domain 口径与 wire（LLM）口径读数一致（差 < 1%）
 */

import { describe, it, expect } from 'vitest';
import { createFileReadTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/builtin.js';
import {
  toolResultBody,
  extractContentBlocks,
} from '@octopi-agent/engine/harness/context/tool-result-body.js';
import {
  resolveToolResultAgingOptions,
  collectToolAgers,
  computeToolResultAgingPlan,
  applyAgingToMessages,
} from '@octopi-agent/engine/harness/context/tool-result-aging.js';
import {
  HeuristicTokenEstimator,
  estimateLLMMessages,
} from '@octopi-agent/engine/harness/context/token-estimator.js';
import { IMAGE_TOKEN_ESTIMATE } from '@octopi-agent/engine/harness/context/token-constants.js';
import type { Message, LLMMessage } from '@octopi-agent/core/types.js';

// ── fixtures ──────────────────────────────────────────────────────────

function imageResult(): Record<string, unknown> {
  return {
    kind: 'image',
    path: '/tmp/demo.png',
    mimeType: 'image/png',
    width: 8,
    height: 8,
    sizeBytes: 75,
    view: 'auto',
    attached: true,
    contentBlocks: [{ type: 'image', data: 'QUFBQUFBQUE=', mimeType: 'image/png', alt: 'png image' }],
  };
}

const AGER_INPUT = (result: unknown): { args: Record<string, unknown>; result: unknown; chars: number } => ({
  args: { path: '/tmp/demo.png' },
  result,
  chars: toolResultBody({ result }).length,
});

// ── 老化：图像分支 ────────────────────────────────────────────────────

describe('图像结果老化（§2.5 定位指针，不保留 base64）', () => {
  const tool = createFileReadTool();

  it('信封图像结果 → [aged] image read 指针', () => {
    const pointer = tool.ageResult?.(AGER_INPUT(imageResult()));
    expect(pointer).toBe('[aged] image read /tmp/demo.png — call file_read for current image');
    expect(pointer).not.toContain('QUFB'); // base64 不滞留
  });

  it('SVG both 模式（已摘要）也丢信封：图像分支先于摘要豁免', () => {
    const bothResult = {
      ...imageResult(),
      kind: 'svg',
      path: '/tmp/demo.svg',
      mimeType: 'image/svg+xml',
      content: '<svg width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
      fromLine: 1,
      toLine: 1,
      totalLines: 1,
      summary: { applied: true },
    };
    const pointer = tool.ageResult?.(AGER_INPUT(bothResult));
    expect(pointer).toBe('[aged] image read /tmp/demo.svg — call file_read for current image');
    expect(pointer).not.toContain('QUFB');
    expect(pointer).not.toContain('<rect');
  });

  it('文本结果行为不变：行指针保留、摘要豁免', () => {
    const textResult = { content: 'x'.repeat(500), fromLine: 1, toLine: 10, totalLines: 100, truncated: false };
    expect(tool.ageResult?.(AGER_INPUT(textResult))).toContain('file_read lines 1-10/100');
    expect(tool.ageResult?.(AGER_INPUT({ ...textResult, summary: { applied: true } }))).toBeUndefined();
  });

  it('不膨胀守卫可过：指针短于结果正文', () => {
    const pointer = tool.ageResult?.(AGER_INPUT(imageResult()))!;
    expect(pointer.length).toBeLessThan(toolResultBody({ result: imageResult() }).length);
  });
});

// ── 老化计划集成：信封随整体改写消失 ──────────────────────────────────

describe('老化计划集成（base64 不滞留视图）', () => {
  it('冻结命中 → applyAgingToMessages 后结果为指针字符串，信封消失', () => {
    const tool = createFileReadTool();
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'file_read', arguments: { path: '/tmp/demo.png' } }],
      },
      { role: 'tool', content: '', toolResults: [{ toolCallId: 'c1', name: 'file_read', result: imageResult() }] },
    ];
    const opts = resolveToolResultAgingOptions();
    const agers = collectToolAgers([{ name: 'file_read', ageResult: tool.ageResult }]);
    // overflow 语境（ignoreTurnBoundary）：全历史候选、批 1——单条即可冻结
    const plan = computeToolResultAgingPlan(messages, opts, { ignoreTurnBoundary: true, toolAgers: agers });
    expect(plan.agedIds.has('c1')).toBe(true);

    const view = applyAgingToMessages(messages, plan, opts);
    const aged = view[1].toolResults?.[0];
    expect(typeof aged?.result).toBe('string');
    expect(String(aged?.result)).toContain('[aged] image read');
    expect(extractContentBlocks(aged?.result)).toHaveLength(0);
    expect(toolResultBody({ result: aged?.result })).not.toContain('QUFB');
  });
});

// ── token 估算核对（估算面 ↔ wire 面同形）────────────────────────────

describe('token 估算：信封图像块计入', () => {
  const est = new HeuristicTokenEstimator();

  it('信封贡献 ≈ 图像固定成本 + label（不再漏计为 0）', () => {
    const withEnv: Message[] = [
      { role: 'tool', content: '', toolResults: [{ toolCallId: 'c1', name: 'file_read', result: imageResult() }] },
    ];
    const stripped = imageResult();
    delete stripped.contentBlocks;
    const without: Message[] = [
      { role: 'tool', content: '', toolResults: [{ toolCallId: 'c1', name: 'file_read', result: stripped }] },
    ];
    const delta = est.estimateMessages(withEnv) - est.estimateMessages(without);
    // 图像固定成本 + '[image: …]' label + 1 条聚合消息开销
    expect(delta).toBeGreaterThanOrEqual(IMAGE_TOKEN_ESTIMATE);
    expect(delta).toBeLessThanOrEqual(IMAGE_TOKEN_ESTIMATE + 50);
  });

  it('同形红线：domain 口径与 wire（LLM）口径读数差 < 1%', () => {
    const result = imageResult();
    const domain: Message[] = [
      { role: 'tool', content: '', toolResults: [{ toolCallId: 'c1', name: 'file_read', result }] },
    ];
    // wire 形状（convertMessage tool 分派）：tool 文本指针 + 一条 engine-authored user 消息挂图
    const wire: LLMMessage[] = [
      {
        role: 'tool',
        content: toolResultBody({ result }),
        tool_call_id: 'c1',
        name: 'file_read',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[image: png image]' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${(result.contentBlocks as { data: string }[])[0].data}` } },
        ],
      },
    ] as unknown as LLMMessage[];
    const domainTokens = est.estimateMessages(domain);
    const wireTokens = estimateLLMMessages(wire);
    expect(wireTokens).toBeGreaterThan(IMAGE_TOKEN_ESTIMATE);
    expect(Math.abs(domainTokens - wireTokens) / wireTokens).toBeLessThan(0.01);
  });
});
