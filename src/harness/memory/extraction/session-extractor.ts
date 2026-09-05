/**
 * Memory Extraction — Session 提取器骨架（Rule-first, 语言无关）
 *
 * 阶段目标：
 * - 先提供一个可回放、可测试的抽取骨架
 * - 依赖结构化 SessionExtractEvent，不依赖自然语言规则
 * - 输出 MemoryCandidate，后续再接语义层（embedding/polarity）
 *
 * 本模块是 memory-extractor 子系统的 Think(code) handler 的默认实现。
 *
 * @module harness/memory/extraction/session-extractor
 */

import type { MemoryType } from '../types.js';

// ── 提取事件（独立于主 session messages） ──

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

export interface RunSummary {
  totalTurns: number;
  totalToolCalls: number;
  failureRate: number;
  majorErrors: string[];
  resolvedErrors: string[];
}

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

export interface MemoryCandidate {
  type: MemoryType;
  content: string;
  source: string; // sessionId + turnId
  evidence: string[];
  confidence: number;
  importance: number;
  tags: string[];
}

// ── 规则信号（语言无关） ──

function countEvents(bundle: SessionExtractBundle, type: SessionExtractEventType): number {
  return bundle.events.filter((e) => e.type === type).length;
}

function uniqueTurnIds(events: SessionExtractEvent[]): string[] {
  return [...new Set(events.map((e) => e.turnId).filter(Boolean))] as string[];
}

// ── 提取器 ──

export class SessionExtractor {
  extract(bundle: SessionExtractBundle): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];

    // 1) preference（用户约束/确认）
    const constraintCount = countEvents(bundle, 'constraint_set') + countEvents(bundle, 'user_confirm');
    if (constraintCount >= 1) {
      const turnIds = uniqueTurnIds(bundle.events.filter((e) => e.type === 'constraint_set' || e.type === 'user_confirm'));
      candidates.push({
        type: 'preference',
        content: `用户在会话中明确表达/确认了 ${constraintCount} 条约束或偏好`,
        source: `session:${bundle.sessionId};turns:${turnIds.join(',') || 'unknown'}`,
        evidence: bundle.events.filter((e) => e.type === 'constraint_set' || e.type === 'user_confirm').map((e, i) => `evt_${i}`),
        confidence: Math.min(1, 0.6 + constraintCount * 0.1),
        importance: 0.7,
        tags: ['preference', 'human'],
      });
    }

    // 2) decision（决策点）
    const decisionCount = countEvents(bundle, 'decision_made') + countEvents(bundle, 'decision_override');
    if (decisionCount >= 1) {
      const turnIds = uniqueTurnIds(bundle.events.filter((e) => e.type === 'decision_made' || e.type === 'decision_override'));
      candidates.push({
        type: 'decision',
        content: `会话中形成/覆盖了 ${decisionCount} 个关键决策`,
        source: `session:${bundle.sessionId};turns:${turnIds.join(',') || 'unknown'}`,
        evidence: bundle.events.filter((e) => e.type === 'decision_made' || e.type === 'decision_override').map((_, i) => `dec_${i}`),
        confidence: 0.8,
        importance: 0.8,
        tags: ['decision'],
      });
    }

    // 3) lesson（失败→修复）
    const failureCount = countEvents(bundle, 'tool_failure') + countEvents(bundle, 'error');
    const fixCount = countEvents(bundle, 'fix_applied');
    if (failureCount >= 2 && fixCount >= 1) {
      candidates.push({
        type: 'lesson',
        content: `出现 ${failureCount} 次失败并在后续修复 ${fixCount} 次，形成可复用经验`,
        source: `session:${bundle.sessionId}`,
        evidence: ['failure_count', 'fix_count'],
        confidence: 0.78,
        importance: 0.85,
        tags: ['lesson', 'reliability'],
      });
    }

    // 4) discovery（总结型发现）
    const summaryCount = countEvents(bundle, 'assistant_summary');
    if (summaryCount >= 1) {
      candidates.push({
        type: 'discovery',
        content: `助手在会话中给出了 ${summaryCount} 次关键总结/发现`,
        source: `session:${bundle.sessionId}`,
        evidence: ['assistant_summary'],
        confidence: 0.66,
        importance: 0.7,
        tags: ['discovery'],
      });
    }

    return candidates;
  }
}
