/**
 * purpose 在参数老化中必须存活（2026-11-13）
 *
 * 背景：purpose 是「这次调用做了什么、为什么」的唯一人类可读记录，也是用户理解
 * 任务过程的主要手段（arch/tool-call-purpose.md）。它作为普通参数进入 tool_call
 * arguments，因此会随结果老化一起走过 agedToolArgDigest。
 *
 * 实测生产会话 424 条 purpose 中有 14 条（3.3%）被降级为
 * `{"$octopi_elided":{"chars":N}}`——它们长 66–77 字符，恰好越过通用阈值
 * ARG_VALUE_KEEP_CHARS=64，被砍掉的正是信息本身。
 *
 * 约束：purpose 不占内容预算（每调用至多一条，天然有界），但保留上限
 * PURPOSE_KEEP_CHARS=160——超长仍降级，避免被当作第二个内容通道。
 */

import { describe, it, expect } from 'vitest';
import {
  agedToolArgDigest,
  resolveToolResultAgingOptions,
} from '@octopi-agent/engine/harness/context/tool-result-aging.js';

const OPTS = (over?: Partial<ReturnType<typeof resolveToolResultAgingOptions>>) => ({
  ...resolveToolResultAgingOptions({}),
  ...over,
});

describe('purpose 不被内容预算挤掉', () => {
  it('契约内长度（≤120）的 purpose 逐字保留', () => {
    const purpose = '查看老化实现，确认 purpose 字段在参数降级时是否被截断';
    const args = { path: '/a/b.ts', purpose };
    const out = agedToolArgDigest('file_read', args, OPTS()) as Record<string, unknown>;
    expect(out.purpose).toBe(purpose);
  });

  it('超过通用阈值 64 但仍在 purpose 上限内的（如 75 字符）也保留', () => {
    // 实测被误降级的那批：JSON 长度 66–77
    const purpose = 'x'.repeat(75);
    const args = { path: '/a/b.ts', purpose };
    const out = agedToolArgDigest('file_read', args, OPTS()) as Record<string, unknown>;
    expect(out.purpose).toBe(purpose);
  });

  it('即使内容载荷很大触发预算压缩，purpose 仍保留原文', () => {
    const purpose = '把旧的占位实现替换掉，改走统一入口，避免两套逻辑漂移';
    const big = 'y'.repeat(5000);
    const args = { path: '/a/b.ts', old_text: big, new_text: big + 'z', purpose };
    const out = agedToolArgDigest('file_edit', args, OPTS()) as Record<string, unknown>;
    expect(out.purpose).toBe(purpose);
    // 载荷照常被降级（预算只牺牲内容值）
    expect(JSON.stringify(out.old_text)).toContain('$octopi_elided');
  });

  it('超长 purpose（>160）仍降级——不把它变成第二个内容通道', () => {
    const purpose = 'p'.repeat(400);
    const args = { path: '/a/b.ts', purpose };
    const out = agedToolArgDigest('file_read', args, OPTS()) as Record<string, unknown>;
    expect(JSON.stringify(out.purpose)).toContain('$octopi_elided');
  });

  it('键名与定位字段行为不变（回归）', () => {
    const args = { path: '/very/long/path/' + 'd/'.repeat(120) + 'file.ts', purpose: 'p' };
    const out = agedToolArgDigest('file_read', args, OPTS()) as Record<string, unknown>;
    expect(Object.keys(out)).toContain('path');
    expect(out.purpose).toBe('p');
    // 超长定位字段才降级（LOCATOR_KEEP_CHARS=200）
    expect(JSON.stringify(out.path)).toContain('$octopi_elided');
  });

  it('ageToolArgs=false 时原样返回', () => {
    const args = { purpose: 'x'.repeat(100) };
    const out = agedToolArgDigest('file_read', args, OPTS({ ageToolArgs: false }));
    expect(out).toBe(args);
  });
});
