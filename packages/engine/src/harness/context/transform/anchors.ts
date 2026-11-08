/**
 * Message anchors — stable coordinates for transform records.
 *
 * Messages in the session log are append-only and immutable (tool-result
 * aging is view-level), so a content identity hash is a stable coordinate
 * across restarts and session forks. `occurrence` disambiguates byte-identical
 * duplicates in stream order; `indexHint` is only a resolution fast path.
 *
 * Ephemeral messages (never persisted) are never anchorable: a record whose
 * boundary would fall on one is trimmed inward at creation (see
 * {@link anchorRange}), so anchors always resolve against the persisted stream.
 *
 * @module harness/context/transform/anchors
 */

import { createHash } from 'node:crypto';
import type { Message } from '@octopi-agent/core/types.js';
import type { MessageAnchor, TransformRun } from './types.js';

/**
 * Canonical identity hash of a message.
 *
 * Covers the persisted identity fields (role / content / toolCalls / toolResults
 * / source / timestamp / agentId / metadata). Only `ephemeral` is excluded —
 * it is in-run only, never persisted, and must not affect identity.
 *
 * @param m - message
 * @returns sha256 hex of the canonical form
 */
export function canonicalMessageHash(m: Message): string {
  return createHash('sha256')
    .update(canonicalJson({ role: m.role, content: m.content, toolCalls: m.toolCalls, toolResults: m.toolResults, source: m.source, timestamp: m.timestamp, agentId: m.agentId, metadata: m.metadata }), 'utf8')
    .digest('hex');
}

/** Deterministic JSON: object keys sorted recursively. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Build the anchor for messages[index], with occurrence counted in stream order.
 *
 * @param messages - full message stream (may include ephemeral entries)
 * @param index - raw index
 * @returns anchor
 */
export function anchorFor(messages: Message[], index: number): MessageAnchor {
  const hash = canonicalMessageHash(messages[index]!);
  let occurrence = 0;
  for (let i = 0; i < index; i++) {
    // 与 resolveAnchor 对称（评审 F8）：ephemeral 不参与 occurrence 计数，
    // 否则「创建时含 ephemeral 同形、解析时被跳过」会错位失锚
    if (messages[i]?.ephemeral) continue;
    if (canonicalMessageHash(messages[i]!) === hash) occurrence += 1;
  }
  return { hash, occurrence, indexHint: index };
}

/**
 * Resolve an anchor to a raw index in the current stream.
 *
 * Fast path: `indexHint` when the hash still matches there (append-only
 * streams keep earlier indices stable). Slow path: the occurrence-th message
 * with the anchor hash. Ephemeral messages are skipped during scanning — they
 * cannot be anchors, and their presence/absence must not shift resolution.
 *
 * @param messages - current message stream
 * @param anchor - anchor to resolve
 * @returns raw index, or undefined when unresolvable (orphan)
 */
export function resolveAnchor(messages: Message[], anchor: MessageAnchor): number | undefined {
  const hinted = messages[anchor.indexHint];
  if (hinted && !hinted.ephemeral && canonicalMessageHash(hinted) === anchor.hash) {
    return anchor.indexHint;
  }
  let seen = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.ephemeral) continue;
    if (canonicalMessageHash(m) !== anchor.hash) continue;
    if (seen === anchor.occurrence) return i;
    seen += 1;
  }
  return undefined;
}

/**
 * Anchor an inclusive index range `[start, end]`, trimming ephemeral
 * boundaries inward so both anchors resolve against the persisted stream.
 *
 * @param messages - full message stream
 * @param start - inclusive raw start index
 * @param end - inclusive raw end index
 * @returns run, or undefined when no non-ephemeral message remains in range
 */
export function anchorRange(messages: Message[], start: number, end: number): TransformRun | undefined {
  let a = start;
  let b = end;
  while (a <= b && messages[a]?.ephemeral) a += 1;
  while (b >= a && messages[b]?.ephemeral) b -= 1;
  if (a > b) return undefined;
  return { from: anchorFor(messages, a), to: anchorFor(messages, b) };
}

/**
 * Resolve a run to an inclusive raw index range.
 *
 * @param messages - current message stream
 * @param run - run to resolve
 * @returns `[start, end]` inclusive, or undefined when either anchor is orphan
 */
export function resolveRun(
  messages: Message[],
  run: TransformRun,
): [number, number] | undefined {
  const a = resolveAnchor(messages, run.from);
  const b = resolveAnchor(messages, run.to);
  if (a === undefined || b === undefined || b < a) return undefined;
  return [a, b];
}
