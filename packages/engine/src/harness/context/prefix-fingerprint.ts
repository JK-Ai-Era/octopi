/**
 * 缓存前缀指纹（可观测护栏）
 *
 * 事故背景（2026-11-12）：摘要请求的前缀与主请求"看起来同形"，实际整包 tools 缺失，
 * provider 只回报 `inputCachedTokens: 0`——从读数完全看不出**是谁变了**，只能靠人工
 * 逐字节比对 wire dump 才定位。本模块把"前缀是否同形"变成可判定、可打印的事实。
 *
 * 指纹刻意只覆盖**前缀**（tools → system → messages 的保护段），不含尾部指令：
 * 摘要请求本来就要在尾部追加一条指令，那一段不可能也不应该相同。
 *
 * @module harness/context/prefix-fingerprint
 */

import { createHash } from 'node:crypto';
import type { LLMMessage, LLMToolDefinition } from '@octopi-agent/core/interfaces/model-provider.js';
import type { RequestView } from '@octopi-agent/core/loop/types.js';

/**
 * 前缀指纹：三项独立哈希 + 前缀消息条数。
 *
 * 三项分开而不用一个大哈希——差异定位需要知道**是 tools 还是 system 还是 messages 变了**。
 */
export interface PrefixFingerprint {
  /** 工具面哈希（provider 格式 JSON 的 sha1 前 16 位） */
  toolsHash: string;
  /** 托管 system 文本哈希（messages 中第一条 system） */
  systemHash: string;
  /** 前缀消息（不含尾部指令）整体哈希 */
  prefixHash: string;
  /** 参与前缀的消息条数 */
  prefixCount: number;
}

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 计算请求视图的前缀指纹
 *
 * @param view - 请求视图
 * @param input.tailLength - 尾部追加的消息条数（摘要指令）；从指纹范围中剔除
 * @returns 前缀指纹
 */
export function fingerprintRequestView(
  view: RequestView,
  input?: { tailLength?: number },
): PrefixFingerprint {
  const tailLength = Math.max(0, input?.tailLength ?? 0);
  const prefix = tailLength > 0 ? view.messages.slice(0, -tailLength) : view.messages;
  const system = prefix.find((m) => m.role === 'system');
  return {
    toolsHash: sha1(JSON.stringify(view.tools)),
    systemHash: sha1(typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content ?? '')),
    prefixHash: sha1(JSON.stringify(prefix satisfies LLMMessage[])),
    prefixCount: prefix.length,
  };
}

/**
 * 比对两个前缀指纹，返回**具体是哪一项不同**（同形时返回空数组）。
 *
 * @param a - 会话请求的前缀指纹
 * @param b - 摘要请求的前缀指纹
 * @returns 差异项名称列表（空 = 前缀同形，缓存可命中）
 */
export function diffPrefixFingerprint(
  a: PrefixFingerprint,
  b: PrefixFingerprint,
): Array<'tools' | 'system' | 'messages'> {
  const out: Array<'tools' | 'system' | 'messages'> = [];
  if (a.toolsHash !== b.toolsHash) out.push('tools');
  if (a.systemHash !== b.systemHash) out.push('system');
  // tools/system 不同必然导致整体不同，避免重复报告 messages
  if (out.length === 0 && a.prefixHash !== b.prefixHash) out.push('messages');
  return out;
}
