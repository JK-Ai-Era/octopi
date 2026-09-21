/**
 * Summary 预置策略（整策略可被配置同 id 替换）
 *
 * @module harness/capabilities/summary/policies
 */

import type { SummaryPolicy } from './types.js';

const DEFAULT_OVERSIZE = {
  strategy: 'map_reduce' as const,
  maxChunks: 6,
  chunkOverlapTokens: 200,
  onPartial: 'mark' as const,
};

const TOOL_WINDOW_OVERSIZE = {
  strategy: 'window' as const,
  maxChunks: 4,
  chunkOverlapTokens: 120,
  onPartial: 'mark' as const,
};

/**
 * 内置 SummaryPolicy 表
 *
 * @returns policy id → 完整策略对象
 */
export function createDefaultSummaryPolicies(): Record<string, SummaryPolicy> {
  const policies: SummaryPolicy[] = [
    {
      id: 'web_page_extract',
      contentKind: 'web_page',
      extract: {
        include: [
          'Page main title and factual body content',
          'Key data, numbers, status, API details',
          'Actionable conclusions and official links',
        ],
        exclude: [
          'Navigation menus, sidebars, footers, cookie banners',
          'Ads, recommended feeds, unrelated promos',
          'Script/style blobs and repeated chrome',
        ],
      },
      preserve: ['full URLs', 'error codes', 'version numbers', 'prices and dates'],
      budget: { maxInputTokens: 24000, maxOutputTokens: 2000 },
      output: 'text',
      oversized: DEFAULT_OVERSIZE,
    },
    {
      id: 'api_json_extract',
      contentKind: 'api_json',
      extract: {
        include: ['Top-level fields and meaning', 'Error codes/messages', 'Pagination/auth related keys'],
        exclude: ['Verbose debug dumps when not asked'],
      },
      preserve: ['field names', 'numeric ids', 'status codes'],
      budget: { maxInputTokens: 16000, maxOutputTokens: 1600 },
      output: 'text',
      oversized: DEFAULT_OVERSIZE,
    },
    {
      id: 'file_text_extract',
      contentKind: 'file_text',
      extract: {
        include: ['Main points and structure', 'Constraints and configuration values'],
        exclude: ['Boilerplate repeats'],
      },
      preserve: ['paths', 'config keys', 'literal values'],
      budget: { maxInputTokens: 20000, maxOutputTokens: 1800 },
      output: 'text',
      oversized: DEFAULT_OVERSIZE,
    },
    {
      id: 'code_overview',
      contentKind: 'code',
      extract: {
        include: ['Module responsibility', 'Exported symbols', 'Key control flow'],
        exclude: ['Full source paste', 'Generated noise'],
      },
      preserve: ['export names', 'file paths', 'error strings'],
      budget: { maxInputTokens: 20000, maxOutputTokens: 1600 },
      output: 'text',
      oversized: DEFAULT_OVERSIZE,
    },
    {
      id: 'document_extract',
      contentKind: 'document',
      extract: {
        include: ['Facts', 'Steps', 'Constraints', 'Configuration items'],
        exclude: ['Marketing fluff'],
      },
      preserve: ['procedure order', 'exact option names'],
      budget: { maxInputTokens: 20000, maxOutputTokens: 1800 },
      output: 'text',
      oversized: DEFAULT_OVERSIZE,
    },
    {
      id: 'log_digest',
      contentKind: 'log',
      extract: {
        include: ['Errors and exceptions', 'Anomalies', 'Key timestamps and counts'],
        exclude: ['Repetitive healthy heartbeats unless asked'],
      },
      preserve: ['error codes', 'timestamps', 'request ids'],
      budget: { maxInputTokens: 16000, maxOutputTokens: 1400 },
      output: 'text',
      oversized: TOOL_WINDOW_OVERSIZE,
    },
    {
      id: 'opaque_generic',
      contentKind: 'opaque',
      extract: {
        include: ['Useful facts and key conclusions'],
        exclude: ['Noise without decision value'],
      },
      preserve: ['identifiers', 'numbers', 'urls'],
      budget: { maxInputTokens: 12000, maxOutputTokens: 1200 },
      output: 'text',
      oversized: TOOL_WINDOW_OVERSIZE,
    },
    {
      id: 'conversation_default',
      contentKind: 'conversation',
      extract: {
        include: [
          'Goal of the conversation',
          'Completed / in-progress / blocked work',
          'Key decisions and reasons',
          'Relevant files, errors, next steps',
        ],
        exclude: ['Pleasantries'],
      },
      preserve: ['file paths', 'error messages', 'specific values'],
      budget: { maxInputTokens: 24000, maxOutputTokens: 2000 },
      output: 'text',
      oversized: DEFAULT_OVERSIZE,
    },
  ];

  const map: Record<string, SummaryPolicy> = {};
  for (const p of policies) map[p.id] = p;
  return map;
}
