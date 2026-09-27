/**
 * Tool-call loop detection (no-progress pattern matching)
 *
 * 参考 OpenClaw 的 tool-loop-detection 设计：
 * - 不限制工具调用次数（多步工作是正常的）
 * - 检测"相同调用 + 相同结果"的无进展重复
 * - 使用 hash(tool_name + params + result) 作为指纹
 *
 * 检测器：
 * 1. generic_repeat — 同工具 + 同参数 + 同结果 → 无进展
 * 2. ping_pong — 两个工具交替调用 + 无进展
 * 3. global_circuit_breaker — 全局无进展调用达到上限
 */

import { createHash } from 'node:crypto';

// ── 配置 ──

export interface ToolLoopDetectionConfig {
  enabled?: boolean;
  historySize?: number;
  warningThreshold?: number;
  criticalThreshold?: number;
  globalCircuitBreakerThreshold?: number;
}

const DEFAULT_CONFIG: Required<ToolLoopDetectionConfig> = {
  enabled: false,
  historySize: 30,
  warningThreshold: 10,
  criticalThreshold: 20,
  globalCircuitBreakerThreshold: 30,
};

// ── 工具调用记录 ──

export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash?: string;
  timestamp: number;
}

// ── 检测结果 ──

export type LoopDetectorKind = 'generic_repeat' | 'ping_pong' | 'global_circuit_breaker';

export type LoopDetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      level: 'warning' | 'critical';
      detector: LoopDetectorKind;
      count: number;
      message: string;
      pairedToolName?: string;
    };

// ── 工具函数 ──

export function hashToolCall(toolName: string, params: unknown): string {
  return toolName + ':' + digestStable(params);
}

export function hashToolOutcome(
  toolName: string,
  params: unknown,
  result: unknown,
  error: unknown,
): string | undefined {
  if (error !== undefined) return 'error:' + digestStable(formatError(error));
  if (result === undefined) return undefined;
  return digestStable(result);
}

function digestStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return stableStringify(error);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

// ── 无进展检测 ──

function getNoProgressStreak(
  history: ToolCallRecord[],
  toolName: string,
  argsHash: string,
): { count: number; latestResultHash?: string } {
  let streak = 0;
  let latestResultHash: string | undefined;

  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i];
    if (!record || record.toolName !== toolName || record.argsHash !== argsHash) continue;
    if (typeof record.resultHash !== 'string' || !record.resultHash) continue;
    if (!latestResultHash) {
      latestResultHash = record.resultHash;
      streak = 1;
      continue;
    }
    if (record.resultHash !== latestResultHash) break;
    streak++;
  }

  return { count: streak, latestResultHash };
}

function getPingPongStreak(
  history: ToolCallRecord[],
  currentArgsHash: string,
): { count: number; pairedToolName?: string; noProgressEvidence: boolean } {
  const last = history.at(-1);
  if (!last) return { count: 0, noProgressEvidence: false };

  let otherArgsHash: string | undefined;
  let otherToolName: string | undefined;
  for (let i = history.length - 2; i >= 0; i--) {
    const call = history[i];
    if (!call || call.argsHash === last.argsHash) continue;
    otherArgsHash = call.argsHash;
    otherToolName = call.toolName;
    break;
  }

  if (!otherArgsHash || !otherToolName) return { count: 0, noProgressEvidence: false };

  let alternatingCount = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const call = history[i];
    if (!call) continue;
    const expected = alternatingCount % 2 === 0 ? last.argsHash : otherArgsHash;
    if (call.argsHash !== expected) break;
    alternatingCount++;
  }

  if (alternatingCount < 2) return { count: 0, noProgressEvidence: false };

  const tailStart = Math.max(0, history.length - alternatingCount);
  let firstHashA: string | undefined;
  let firstHashB: string | undefined;
  let noProgressEvidence = true;

  for (let i = tailStart; i < history.length; i++) {
    const call = history[i];
    if (!call || !call.resultHash) { noProgressEvidence = false; break; }
    if (call.argsHash === last.argsHash) {
      if (!firstHashA) firstHashA = call.resultHash;
      else if (firstHashA !== call.resultHash) { noProgressEvidence = false; break; }
    } else if (call.argsHash === otherArgsHash) {
      if (!firstHashB) firstHashB = call.resultHash;
      else if (firstHashB !== call.resultHash) { noProgressEvidence = false; break; }
    } else {
      noProgressEvidence = false;
      break;
    }
  }

  if (!firstHashA || !firstHashB) noProgressEvidence = false;

  return {
    count: alternatingCount + 1,
    pairedToolName: otherToolName,
    noProgressEvidence,
  };
}

// ── 主检测函数 ──

export function detectNoProgressLoop(
  history: ToolCallRecord[],
  toolName: string,
  params: unknown,
  config?: ToolLoopDetectionConfig,
): LoopDetectionResult {
  const resolved = resolveConfig(config);
  if (!resolved.enabled) return { stuck: false };

  const argsHash = hashToolCall(toolName, params);

  // 1. 全局熔断
  const globalNoProgress = getNoProgressStreak(history, toolName, argsHash);
  if (globalNoProgress.count >= resolved.globalCircuitBreakerThreshold) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'global_circuit_breaker',
      count: globalNoProgress.count,
      message: 'CRITICAL: ' + toolName + ' repeated identical no-progress outcomes ' + globalNoProgress.count + ' times. Circuit breaker triggered.',
    };
  }

  // 2. Ping-pong 检测
  const pingPong = getPingPongStreak(history, argsHash);
  if (pingPong.noProgressEvidence && pingPong.count >= resolved.criticalThreshold) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'ping_pong',
      count: pingPong.count,
      message: 'CRITICAL: Alternating tool-call pattern (' + pingPong.count + ' calls) with no progress.',
      pairedToolName: pingPong.pairedToolName,
    };
  }
  if (pingPong.noProgressEvidence && pingPong.count >= resolved.warningThreshold) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'ping_pong',
      count: pingPong.count,
      message: 'WARNING: Alternating tool-call pattern (' + pingPong.count + ' calls). If not making progress, stop retrying.',
      pairedToolName: pingPong.pairedToolName,
    };
  }

  // 3. 通用重复检测（同参数 + 同结果）
  if (globalNoProgress.count >= resolved.criticalThreshold) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'generic_repeat',
      count: globalNoProgress.count,
      message: 'CRITICAL: ' + toolName + ' repeated ' + globalNoProgress.count + ' times with identical arguments and outcomes.',
    };
  }

  // 统计同参数调用次数 — 但如果结果各不相同（有进展），不算 stuck
  const recentCount = history.filter(h => h.toolName === toolName && h.argsHash === argsHash).length;
  if (recentCount >= resolved.warningThreshold) {
    // 检查这些同参数调用的结果是否一致（无进展）
    const sameArgsCalls = history.filter(h => h.toolName === toolName && h.argsHash === argsHash);
    const distinctResults = new Set(sameArgsCalls.map(h => h.resultHash).filter(Boolean));
    // 如果结果各不相同（超过半数是唯一的），说明每次都有进展，不算 loop
    if (distinctResults.size >= recentCount * 0.5) {
      return { stuck: false };
    }
    return {
      stuck: true,
      level: 'warning',
      detector: 'generic_repeat',
      count: recentCount,
      message: 'WARNING: ' + toolName + ' called ' + recentCount + ' times with identical arguments.',
    };
  }

  return { stuck: false };
}

// ── 记录函数 ──

export function recordToolCall(
  history: ToolCallRecord[],
  toolName: string,
  params: unknown,
  result?: unknown,
  error?: unknown,
  config?: ToolLoopDetectionConfig,
): ToolCallRecord[] {
  const resolved = resolveConfig(config);
  const argsHash = hashToolCall(toolName, params);
  const resultHash = hashToolOutcome(toolName, params, result, error);

  const record: ToolCallRecord = {
    toolName,
    argsHash,
    resultHash,
    timestamp: Date.now(),
  };

  const updated = [...history, record];
  if (updated.length > resolved.historySize) {
    return updated.slice(updated.length - resolved.historySize);
  }
  return updated;
}

// ── 内部 ──

function resolveConfig(config?: ToolLoopDetectionConfig): Required<ToolLoopDetectionConfig> {
  if (!config) return DEFAULT_CONFIG;
  return {
    enabled: config.enabled ?? DEFAULT_CONFIG.enabled,
    historySize: config.historySize ?? DEFAULT_CONFIG.historySize,
    warningThreshold: config.warningThreshold ?? DEFAULT_CONFIG.warningThreshold,
    criticalThreshold: config.criticalThreshold ?? DEFAULT_CONFIG.criticalThreshold,
    globalCircuitBreakerThreshold: config.globalCircuitBreakerThreshold ?? DEFAULT_CONFIG.globalCircuitBreakerThreshold,
  };
}
