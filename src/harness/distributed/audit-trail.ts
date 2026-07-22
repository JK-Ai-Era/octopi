/**
 * Distributed Intelligence — AuditTrail
 *
 * 审计追踪，监听 EventBus 上的 distributed_agent.* 事件，持久化到 JSONL 文件。
 * 支持按 agentId、type、since 过滤查询。
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { EventBus, AgentEvent, Disposable } from '../../core/event-bus.js';

// ── AuditEntry ──

/**
 * 审计日志条目
 */
export interface AuditEntry {
  /** 时间戳 */
  timestamp: number;
  /** 事件类型 */
  type: string;
  /** 来源智能体 ID */
  agentId?: string;
  /** 触发信息 */
  trigger?: unknown;
  /** 输入快照 */
  input?: unknown;
  /** 输出快照 */
  output?: unknown;
  /** 执行时长（毫秒） */
  durationMs?: number;
}

// ── AuditTrail 配置 ──

export interface AuditTrailConfig {
  /** EventBus 实例 */
  events: EventBus;
  /** 输出目录 */
  outputDir: string;
  /** 日志文件名（默认 'audit.jsonl'） */
  filename?: string;
}

/**
 * AuditTrail — 审计追踪
 *
 * 监听 EventBus 上的 distributed_agent.* 事件，持久化到 JSONL 文件。
 */
export class AuditTrail {
  private events: EventBus;
  private outputDir: string;
  private filePath: string;
  private disposable?: Disposable;

  constructor(config: AuditTrailConfig) {
    this.events = config.events;
    this.outputDir = config.outputDir;
    this.filePath = join(config.outputDir, config.filename ?? 'audit.jsonl');

    // 确保输出目录存在
    this.ensureDir(this.outputDir);

    // 监听所有 distributed_agent.* 事件
    this.disposable = this.events.onAll((event) => {
      if (event.type.startsWith('distributed_agent.')) {
        this.log(event);
      }
    });
  }

  /**
   * 记录事件到 JSONL 文件
   */
  private log(event: AgentEvent): void {
    const entry: AuditEntry = {
      timestamp: event.timestamp,
      type: event.type,
      agentId: event.agentId,
      trigger: event.data?.trigger,
      input: event.data?.input,
      output: event.data?.output,
      durationMs: event.data?.durationMs as number | undefined,
    };

    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // 静默失败，不阻塞主流程
    }
  }

  /**
   * 查询审计日志
   *
   * @param filter - 过滤条件
   * @returns 匹配的审计条目
   */
  query(filter?: { agentId?: string; type?: string; since?: number }): AuditEntry[] {
    if (!existsSync(this.filePath)) return [];

    try {
      const content = readFileSync(this.filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      const entries: AuditEntry[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as AuditEntry;

          // 过滤
          if (filter?.agentId && entry.agentId !== filter.agentId) continue;
          if (filter?.type && entry.type !== filter.type) continue;
          if (filter?.since && entry.timestamp < filter.since) continue;

          entries.push(entry);
        } catch {
          // 跳过格式错误的行
        }
      }

      return entries;
    } catch {
      return [];
    }
  }

  /**
   * 获取日志文件路径
   */
  get logFilePath(): string {
    return this.filePath;
  }

  /**
   * 停止监听
   */
  dispose(): void {
    this.disposable?.dispose();
  }

  /**
   * 确保目录存在
   */
  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
