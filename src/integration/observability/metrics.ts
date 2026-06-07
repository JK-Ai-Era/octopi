/**
 * Metrics Aggregator — 指标聚合层
 *
 * 从 TraceEvent 流中聚合关键指标：
 * - LLM 调用次数、token 使用、延迟分布
 * - 工具调用次数、延迟、错误率
 * - Session 活跃度、空回复率、重试率
 * - 成本估算
 *
 * 设计原则：
 * - 旁路聚合，不改变业务逻辑
 * - 定期快照，支持时序查询
 * - 通过 Exporter SPI 导出到外部系统
 */

import type { TraceEvent } from './trace-events.js';
import { TraceLevel } from './trace-events.js';
import type { TraceExporter } from './exporters.js';

// ── 延迟统计 ──

export interface LatencyStats {
  count: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  totalMs: number;
}

class LatencyTracker {
  private values: number[] = [];

  record(ms: number): void {
    this.values.push(ms);
  }

  getStats(): LatencyStats {
    if (this.values.length === 0) {
      return { count: 0, avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0, totalMs: 0 };
    }

    const sorted = [...this.values].sort((a, b) => a - b);
    const count = sorted.length;
    const totalMs = sorted.reduce((s, v) => s + v, 0);

    return {
      count,
      avg: Math.round(totalMs / count),
      min: sorted[0],
      max: sorted[count - 1],
      p50: sorted[Math.floor(count * 0.5)],
      p95: sorted[Math.floor(count * 0.95)],
      p99: sorted[Math.floor(count * 0.99)],
      totalMs,
    };
  }

  reset(): void {
    this.values = [];
  }
}

// ── 指标快照 ──

export interface MetricsSnapshot {
  /** 快照时间 */
  ts: number;
  /** 运行时长（ms） */
  uptimeMs: number;

  /** LLM 调用次数 */
  llmCalls: number;
  /** LLM 输入 token 总量 */
  llmTokensInput: number;
  /** LLM 输出 token 总量 */
  llmTokensOutput: number;
  /** LLM 总 token */
  llmTokensTotal: number;
  /** LLM 延迟分布 */
  llmLatency: LatencyStats;
  /** LLM 错误次数 */
  llmErrors: number;

  /** 工具调用次数（按工具名） */
  toolCalls: Record<string, number>;
  /** 工具延迟（按工具名） */
  toolLatency: Record<string, LatencyStats>;
  /** 工具错误（按工具名） */
  toolErrors: Record<string, number>;

  /** 活跃 session 数 */
  sessionsActive: number;
  /** 总 turn 数 */
  turnsTotal: number;
  /** 空回复数 */
  emptyResponses: number;
  /** 重试次数 */
  retriesTotal: number;

  /** 估算成本（USD） */
  estimatedCostUsd: number;
}

// ── 成本估算（每 1M token 的 USD 价格） ──

const DEFAULT_COST_PER_M_TOKEN = {
  input: 3.0,   // $3 / 1M input tokens
  output: 15.0, // $15 / 1M output tokens
};

// ── MetricsAggregator ──

export interface MetricsAggregatorConfig {
  /** 自定义成本估算 */
  costPerMillionTokens?: { input: number; output: number };
  /** 快照间隔（ms，0 = 不自动快照） */
  snapshotIntervalMs?: number;
  /** 快照回调 */
  onSnapshot?: (snapshot: MetricsSnapshot) => void;
}

/**
 * MetricsAggregator — 从事件流聚合指标
 */
export class MetricsAggregator {
  private config: MetricsAggregatorConfig;
  private startTime = Date.now();

  // LLM 指标
  private _llmCalls = 0;
  private _llmTokensInput = 0;
  private _llmTokensOutput = 0;
  private _llmErrors = 0;
  private _llmLatency = new LatencyTracker();

  // 工具指标
  private _toolCalls = new Map<string, number>();
  private _toolLatency = new Map<string, LatencyTracker>();
  private _toolErrors = new Map<string, number>();

  // Session 指标
  private _sessionsActive = new Set<string>();
  private _turnsTotal = 0;
  private _emptyResponses = 0;
  private _retriesTotal = 0;

  // 快照历史
  private _snapshots: MetricsSnapshot[] = [];
  private _snapshotTimer?: ReturnType<typeof setInterval>;

  constructor(config?: MetricsAggregatorConfig) {
    this.config = config ?? {};

    if (this.config.snapshotIntervalMs && this.config.snapshotIntervalMs > 0) {
      this._snapshotTimer = setInterval(() => {
        const snapshot = this.snapshot();
        this.config.onSnapshot?.(snapshot);
        this._snapshots.push(snapshot);
      }, this.config.snapshotIntervalMs);
    }
  }

  /**
   * 处理单个事件
   */
  processEvent(event: TraceEvent): void {
    switch (event.type) {
      // ── LLM 调用 ──
      case 'model.call.start':
        this._llmCalls++;
        if (event.sessionId) this._sessionsActive.add(event.sessionId);
        break;

      case 'model.call.end':
        this._llmLatency.record((event.data?.durationMs as number) ?? 0);
        if (event.data?.usage) {
          const usage = event.data.usage as { promptTokens?: number; completionTokens?: number; totalTokens?: number };
          this._llmTokensInput += usage.promptTokens ?? 0;
          this._llmTokensOutput += usage.completionTokens ?? 0;
        }
        break;

      case 'model.call.error':
        this._llmErrors++;
        break;

      // ── 工具调用 ──
      case 'tool.exec.start': {
        const toolName = (event.data?.toolName as string) ?? 'unknown';
        this._toolCalls.set(toolName, (this._toolCalls.get(toolName) ?? 0) + 1);
        if (!this._toolLatency.has(toolName)) {
          this._toolLatency.set(toolName, new LatencyTracker());
        }
        break;
      }

      case 'tool.exec.end': {
        const toolName = (event.data?.toolName as string) ?? 'unknown';
        const duration = (event.data?.durationMs as number) ?? 0;
        this._toolLatency.get(toolName)?.record(duration);
        if (event.data?.hasError) {
          this._toolErrors.set(toolName, (this._toolErrors.get(toolName) ?? 0) + 1);
        }
        break;
      }

      // ── Turn ──
      case 'turn.start':
        this._turnsTotal++;
        break;

      case 'turn.end':
        if (!event.data?.content || (event.data.content as string).length === 0) {
          this._emptyResponses++;
        }
        break;

      // ── 重试 ──
      case 'retry':
        this._retriesTotal++;
        break;

      // ── 空回复 ──
      case 'empty.response':
        this._emptyResponses++;
        break;
    }
  }

  /**
   * 生成当前快照
   */
  snapshot(): MetricsSnapshot {
    const costConfig = this.config.costPerMillionTokens ?? DEFAULT_COST_PER_M_TOKEN;
    const estimatedCostUsd =
      (this._llmTokensInput / 1_000_000) * costConfig.input +
      (this._llmTokensOutput / 1_000_000) * costConfig.output;

    return {
      ts: Date.now(),
      uptimeMs: Date.now() - this.startTime,

      llmCalls: this._llmCalls,
      llmTokensInput: this._llmTokensInput,
      llmTokensOutput: this._llmTokensOutput,
      llmTokensTotal: this._llmTokensInput + this._llmTokensOutput,
      llmLatency: this._llmLatency.getStats(),
      llmErrors: this._llmErrors,

      toolCalls: Object.fromEntries(this._toolCalls),
      toolLatency: Object.fromEntries(
        [...this._toolLatency.entries()].map(([k, v]) => [k, v.getStats()]),
      ),
      toolErrors: Object.fromEntries(this._toolErrors),

      sessionsActive: this._sessionsActive.size,
      turnsTotal: this._turnsTotal,
      emptyResponses: this._emptyResponses,
      retriesTotal: this._retriesTotal,

      estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
    };
  }

  /**
   * 获取快照历史
   */
  getSnapshots(): MetricsSnapshot[] {
    return [...this._snapshots];
  }

  /**
   * 重置所有指标
   */
  reset(): void {
    this.startTime = Date.now();
    this._llmCalls = 0;
    this._llmTokensInput = 0;
    this._llmTokensOutput = 0;
    this._llmErrors = 0;
    this._llmLatency.reset();
    this._toolCalls.clear();
    this._toolLatency.clear();
    this._toolErrors.clear();
    this._sessionsActive.clear();
    this._turnsTotal = 0;
    this._emptyResponses = 0;
    this._retriesTotal = 0;
    this._snapshots = [];
  }

  /**
   * 停止自动快照
   */
  destroy(): void {
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = undefined;
    }
  }
}

/**
 * 格式化指标快照（人类可读）
 */
export function formatMetricsSnapshot(snap: MetricsSnapshot): string {
  const lines: string[] = [];

  lines.push('📊 Agent Metrics');
  lines.push(`${'─'.repeat(50)}`);
  lines.push(`Uptime:         ${(snap.uptimeMs / 1000).toFixed(0)}s`);
  lines.push(`Sessions:       ${snap.sessionsActive} active`);
  lines.push(`Turns:          ${snap.turnsTotal}`);
  lines.push(`Empty replies:  ${snap.emptyResponses}`);
  lines.push(`Retries:        ${snap.retriesTotal}`);
  lines.push('');
  lines.push('LLM:');
  lines.push(`  Calls:        ${snap.llmCalls}`);
  lines.push(`  Tokens:       ${snap.llmTokensInput} in / ${snap.llmTokensOutput} out`);
  lines.push(`  Latency:      avg=${snap.llmLatency.avg}ms p50=${snap.llmLatency.p50}ms p95=${snap.llmLatency.p95}ms`);
  lines.push(`  Errors:       ${snap.llmErrors}`);
  lines.push(`  Cost:         $${snap.estimatedCostUsd.toFixed(4)}`);

  const toolNames = Object.keys(snap.toolCalls);
  if (toolNames.length > 0) {
    lines.push('');
    lines.push('Tools:');
    for (const name of toolNames) {
      const calls = snap.toolCalls[name];
      const latency = snap.toolLatency[name];
      const errors = snap.toolErrors[name] ?? 0;
      lines.push(`  ${name}: ${calls} calls, avg=${latency?.avg ?? 0}ms, errors=${errors}`);
    }
  }

  lines.push(`${'─'.repeat(50)}`);
  return lines.join('\n');
}
