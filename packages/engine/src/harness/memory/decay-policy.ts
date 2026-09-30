/**
 * Memory 衰减曲线 — 按 MemoryType 的 idle / 步进 / 下限
 *
 * @module harness/memory/decay-policy
 */

import type { MemoryType } from './types.js';

export interface DecayTypeParams {
  /** 距上次访问超过该天数才衰减 */
  idleDays: number;
  /** 每轮衰减乘数（<1） */
  factor: number;
  /** decayFactor 下限 */
  min: number;
}

/**
 * 默认：method 最易过时；norm 最稳；fact 居中。
 */
export const DEFAULT_DECAY_TYPE_PARAMS: Record<MemoryType, DecayTypeParams> = {
  fact: { idleDays: 30, factor: 0.95, min: 0.1 },
  method: { idleDays: 21, factor: 0.93, min: 0.1 },
  norm: { idleDays: 45, factor: 0.97, min: 0.15 },
};

export type DecayParamsConfig = Partial<Record<MemoryType, Partial<DecayTypeParams>>>;

export function resolveDecayParams(config?: DecayParamsConfig): Record<MemoryType, DecayTypeParams> {
  const out = {} as Record<MemoryType, DecayTypeParams>;
  for (const type of ['fact', 'method', 'norm'] as MemoryType[]) {
    out[type] = { ...DEFAULT_DECAY_TYPE_PARAMS[type], ...config?.[type] };
  }
  return out;
}

export function nextDecayFactor(
  current: number,
  type: MemoryType,
  params: Record<MemoryType, DecayTypeParams>,
): number {
  const p = params[type] ?? DEFAULT_DECAY_TYPE_PARAMS[type];
  return Math.max(p.min, current * p.factor);
}

export function isDecayDue(
  lastAccessedAt: number,
  type: MemoryType,
  params: Record<MemoryType, DecayTypeParams>,
  now = Date.now(),
): boolean {
  const p = params[type] ?? DEFAULT_DECAY_TYPE_PARAMS[type];
  return now - lastAccessedAt > p.idleDays * 86_400_000;
}
