/**
 * Wisdom 类型 — 规范定义在 ./types.ts（maxim；见 arch/wisdom-layer-formation.md）
 */

export type {
  WisdomStatus,
  WisdomOrigin,
  WisdomKind,
  WisdomRetireReason,
  WisdomScenario,
  WisdomEffect,
  WisdomDerivation,
  WisdomCounterevidence,
  WisdomOutcomes,
  WisdomEntry,
  WisdomGateReason,
  WisdomGateOutcome,
  AdmitWisdomInput,
  AdmitWisdomAction,
  AdmitWisdomResult,
  WisdomInjectQuery,
  WisdomInjectPick,
  WisdomOutcomeSignal,
  WisdomOutcomeEvent,
  WisdomStats,
  WisdomStore,
} from './types.js';
export {
  WISDOM_STATUSES,
  WISDOM_INJECTABLE_STATUSES,
  WISDOM_ORIGINS,
  WISDOM_KINDS,
} from './types.js';
