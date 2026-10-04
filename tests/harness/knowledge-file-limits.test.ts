/**
 * 知识索引文件限额 — 分级上限 / 超限裁决 / 部分抽取
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KNOWLEDGE_FILE_LIMITS,
  classifyFileKind,
  decideBySize,
  formatMaxBytes,
  isRetryableSkipReason,
  parseTimeoutForSize,
  resolveKnowledgeFileLimits,
} from '@octopi-agent/engine/harness/knowledge/file-limits.js';

describe('classifyFileKind', () => {
  it('maps common extensions to format kinds', () => {
    expect(classifyFileKind('a.pptx')).toBe('officeDoc');
    expect(classifyFileKind('a.docx')).toBe('officeDoc');
    expect(classifyFileKind('a.xlsx')).toBe('sheet');
    expect(classifyFileKind('a.pdf')).toBe('pdf');
    expect(classifyFileKind('a.md')).toBe('text');
    expect(classifyFileKind('a.m4a')).toBe('other');
    expect(classifyFileKind('a.zip')).toBe('other');
  });
});

describe('decideBySize', () => {
  const limits = DEFAULT_KNOWLEDGE_FILE_LIMITS;

  it('allows files under format soft limit', () => {
    expect(decideBySize(10 * 1024 * 1024, 'officeDoc', limits)).toEqual({ action: 'ok' });
  });

  it('soft-oversize pptx becomes partial (not skip)', () => {
    // officeDoc 软限 200MB；210MB 仍低于 hardMax
    const d = decideBySize(210 * 1024 * 1024, 'officeDoc', limits);
    expect(d).toEqual({ action: 'partial', reason: 'oversize_soft' });
  });

  it('sheet over 50MB is partial under default policy', () => {
    const d = decideBySize(138 * 1024 * 1024, 'sheet', limits);
    expect(d.action).toBe('partial');
  });

  it('hardMax always skips even in partial mode', () => {
    const d = decideBySize(300 * 1024 * 1024, 'officeDoc', limits);
    expect(d).toEqual({ action: 'skip', reason: 'oversize_hard' });
  });

  it('oversize=skip policy skips soft-oversize files', () => {
    const skipLimits = resolveKnowledgeFileLimits({ oversize: 'skip' });
    const d = decideBySize(210 * 1024 * 1024, 'officeDoc', skipLimits);
    expect(d).toEqual({ action: 'skip', reason: 'oversize_skip' });
  });

  it('formatMaxBytes honors configured overrides', () => {
    const custom = resolveKnowledgeFileLimits({
      maxBytes: { officeDoc: 1024 },
    });
    expect(formatMaxBytes(custom, 'officeDoc')).toBe(1024);
    expect(decideBySize(2048, 'officeDoc', custom).action).toBe('partial');
  });
});

describe('parseTimeoutForSize', () => {
  it('scales with MB and caps at maxParseTimeoutMs', () => {
    const limits = DEFAULT_KNOWLEDGE_FILE_LIMITS;
    expect(parseTimeoutForSize(0, limits)).toBe(limits.parseTimeoutMs);
    const big = parseTimeoutForSize(100 * 1024 * 1024, limits);
    expect(big).toBe(limits.maxParseTimeoutMs);
  });
});

describe('isRetryableSkipReason', () => {
  const limits = DEFAULT_KNOWLEDGE_FILE_LIMITS;

  it('retries legacy oversize and soft-oversize skips', () => {
    expect(isRetryableSkipReason('oversize', 0, limits)).toBe(true);
    expect(isRetryableSkipReason('oversize_skip', 80 * 1024 * 1024, limits)).toBe(true);
    expect(isRetryableSkipReason('oversize_soft', 80 * 1024 * 1024, limits)).toBe(true);
    expect(isRetryableSkipReason('empty_content', 10, limits)).toBe(true);
  });

  it('does not retry media/zip or permanent hard oversize', () => {
    expect(isRetryableSkipReason('no_adapter', 0, limits)).toBe(false);
    expect(isRetryableSkipReason('ignored_path', 0, limits)).toBe(false);
    expect(isRetryableSkipReason('oversize_hard', 300 * 1024 * 1024, limits)).toBe(false);
  });

  it('retries oversize_hard when hardMax is raised or size unknown', () => {
    expect(isRetryableSkipReason('oversize_hard', 0, limits)).toBe(true);
    const wide = resolveKnowledgeFileLimits({ hardMaxFileBytes: 512 * 1024 * 1024 });
    expect(isRetryableSkipReason('oversize_hard', 300 * 1024 * 1024, wide)).toBe(true);
  });
});
