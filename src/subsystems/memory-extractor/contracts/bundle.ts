/**
 * Memory Extractor Subsystem — 输入/输出契约
 *
 * 定义 memory-extractor 子系统与 harness 层之间的结构化接口。
 * 本文件是 SessionExtractBundle / SessionExtractEvent 等核心类型的规范定义位置。
 *
 * @module subsystems/memory-extractor/contracts/bundle
 */

import type { MemoryType } from '../../../harness/memory/types.js';

// ── 提取事件类型 ──

export type SessionExtractEventType =
  | 'goal_set'
  | 'goal_change'
  | 'constraint_set'
  | 'decision_made'
  | 'decision_override'
  | 'user_confirm'
  | 'user_reject'
  | 'tool_call'
  | 'tool_failure'
  | 'tool_success'
  | 'error'
  | 'fix_applied'
  | 'assistant_summary';

export interface SessionExtractEvent {
  ts: number;
  type: SessionExtractEventType;
  sessionId: string;
  agentId?: string;
  turnId?: string;
  sourceMessageIds?: string[];
  payload?: Record<string, unknown>;
}

// ── 压缩轮次 ──

export interface CondensedTurn {
  turnId: string;
  ts: number;
  userIntent?: string;
  constraints?: string[];
  decisions?: string[];
  toolFailures?: string[];
  toolSuccess?: string[];
  conclusion?: string;
}

// ── 运行摘要 ──

export interface RunSummary {
  totalTurns: number;
  totalToolCalls: number;
  failureRate: number;
  majorErrors: string[];
  resolvedErrors: string[];
}

// ── 输入契约：SessionExtractBundle ──

export interface SessionExtractBundle {
  sessionId: string;
  agentId: string;
  startAt: number;
  endAt?: number;
  events: SessionExtractEvent[];
  condensedTurns: CondensedTurn[];
  runSummary: RunSummary;
  humanCheckpoints?: Array<{
    ts: number;
    kind: 'confirm' | 'reject' | 'goal_change' | 'constraint_set';
    text?: string;
    sourceEventIds?: string[];
  }>;
}

// ── 输出契约：MemoryCandidate ──

export interface MemoryCandidate {
  type: MemoryType;
  content: string;
  source: string;
  evidence: string[];
  confidence: number;
  importance: number;
  tags: string[];
}

// ── 输出契约：ExtractionResult ──

export interface ExtractionResult {
  accepted: MemoryCandidate[];
  candidates: MemoryCandidate[];
  dedupedCount: number;
  gatedCount: number;
}
