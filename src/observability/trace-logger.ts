/**
 * TraceLogger — 可观测性日志器
 *
 * 分级结构化事件日志。支持：
 * - 控制台输出（按级别过滤）
 * - 文件输出（JSONL 格式，完整 trace）
 * - 事件过滤和路由
 *
 * 设计原则：
 * - 观测代码不改变业务逻辑（旁路抄写）
 * - 生产环境用 INFO，调试用 TRACE
 * - 每次运行生成独立 trace 文件
 */

import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TraceLevel,
  TRACE_LEVEL_NAMES,
  getTraceLevelForEngineEvent,
  type TraceEvent,
} from './trace-events.js';
import type { TraceExporter } from './exporters.js';

export { TraceLevel, TRACE_LEVEL_NAMES };
export type { TraceEvent };

/** TraceLogger 配置 */
export interface TraceLoggerConfig {
  /** 最大记录级别（低于此级别的事件被过滤） */
  level: TraceLevel;
  /** 控制台输出级别（null = 不输出到控制台） */
  consoleLevel?: TraceLevel | null;
  /** 文件输出目录（null = 不输出到文件） */
  outputDir?: string | null;
  /** Trace 文件名前缀 */
  filePrefix?: string;
  /** 是否同步写入（调试用，生产用异步） */
  sync?: boolean;
  /** 外部导出器列表 */
  exporters?: TraceExporter[];
}

const DEFAULT_CONFIG: TraceLoggerConfig = {
  level: TraceLevel.INFO,
  consoleLevel: TraceLevel.INFO,
  outputDir: null,
  filePrefix: 'trace',
  sync: false,
};

/**
 * TraceLogger
 */
export class TraceLogger {
  private config: TraceLoggerConfig;
  private filePath?: string;
  private eventCount = 0;
  private startTime = Date.now();

  private exporters: TraceExporter[] = [];

  constructor(config?: Partial<TraceLoggerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // 初始化导出器
    this.exporters = config?.exporters ?? [];

    // 初始化文件输出（兼容旧的 outputDir 模式）
    if (this.config.outputDir) {
      const dir = this.config.outputDir;
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const prefix = this.config.filePrefix ?? 'trace';
      this.filePath = join(dir, `${prefix}-${ts}.jsonl`);

      // 写入 trace 头部
      this.writeToFile({
        ts: this.startTime,
        level: TraceLevel.INFO,
        type: 'trace.start',
        data: {
          level: TRACE_LEVEL_NAMES[this.config.level],
          outputDir: this.config.outputDir,
          filePath: this.filePath,
        },
      });
    }
  }

  /**
   * 记录事件
   */
  log(event: TraceEvent): void {
    this.eventCount++;

    // 级别过滤
    if (event.level > this.config.level) return;

    // 控制台输出
    if (this.config.consoleLevel !== null && event.level <= (this.config.consoleLevel ?? this.config.level)) {
      this.logToConsole(event);
    }

    // 文件输出（兼容旧模式）
    if (this.filePath) {
      this.writeToFile(event);
    }

    // 分发到导出器
    if (this.exporters.length > 0) {
      for (const exporter of this.exporters) {
        exporter.export([event]).catch(() => {});
      }
    }
  }

  /**
   * 快捷方法：记录不同级别的事件
   */
  fatal(type: string, data?: Record<string, unknown>, ctx?: { sessionId?: string; agentId?: string }): void {
    this.log({ ts: Date.now(), level: TraceLevel.FATAL, type, data, ...ctx });
  }

  error(type: string, data?: Record<string, unknown>, ctx?: { sessionId?: string; agentId?: string }): void {
    this.log({ ts: Date.now(), level: TraceLevel.ERROR, type, data, ...ctx });
  }

  warn(type: string, data?: Record<string, unknown>, ctx?: { sessionId?: string; agentId?: string }): void {
    this.log({ ts: Date.now(), level: TraceLevel.WARN, type, data, ...ctx });
  }

  info(type: string, data?: Record<string, unknown>, ctx?: { sessionId?: string; agentId?: string }): void {
    this.log({ ts: Date.now(), level: TraceLevel.INFO, type, data, ...ctx });
  }

  debug(type: string, data?: Record<string, unknown>, ctx?: { sessionId?: string; agentId?: string }): void {
    this.log({ ts: Date.now(), level: TraceLevel.DEBUG, type, data, ...ctx });
  }

  trace(type: string, data?: Record<string, unknown>, ctx?: { sessionId?: string; agentId?: string }): void {
    this.log({ ts: Date.now(), level: TraceLevel.TRACE, type, data, ...ctx });
  }

  /**
   * 从引擎事件创建 TraceEvent 并记录
   */
  logEngineEvent(event: { type: string; timestamp: number; data?: Record<string, unknown>; sessionId?: string; agentId?: string }): void {
    this.log({
      ts: event.timestamp,
      level: getTraceLevelForEngineEvent(event.type),
      type: event.type,
      sessionId: event.sessionId,
      agentId: event.agentId,
      data: event.data,
    });
  }

  /**
   * 获取 trace 文件路径
   */
  getFilePath(): string | undefined {
    return this.filePath;
  }

  /**
   * 获取已记录的事件数量
   */
  getEventCount(): number {
    return this.eventCount;
  }

  /**
   * 添加导出器
   */
  addExporter(exporter: TraceExporter): void {
    this.exporters.push(exporter);
  }

  /**
   * 结束 trace，写入统计信息
   */
  async finalize(): Promise<void> {
    const endEvent: TraceEvent = {
      ts: Date.now(),
      level: TraceLevel.INFO,
      type: 'trace.end',
      data: {
        eventCount: this.eventCount,
        durationMs: Date.now() - this.startTime,
      },
    };

    if (this.filePath) {
      this.writeToFile(endEvent);
    }

    // flush 并关闭所有导出器
    for (const exporter of this.exporters) {
      await exporter.export([endEvent]).catch(() => {});
      await exporter.flush().catch(() => {});
    }
  }

  // ── 内部方法 ──

  private logToConsole(event: TraceEvent): void {
    const levelName = TRACE_LEVEL_NAMES[event.level];
    const ts = new Date(event.ts).toISOString().substring(11, 23);
    const prefix = `[${ts}] ${levelName.padEnd(5)}`;

    // 简化数据展示
    let dataStr = '';
    if (event.data) {
      const entries = Object.entries(event.data);
      if (entries.length > 0) {
        dataStr = ' ' + entries
          .map(([k, v]) => {
            const val = typeof v === 'string' ? v.substring(0, 80) : JSON.stringify(v);
            return `${k}=${val}`;
          })
          .join(' ');
      }
    }

    const line = `${prefix} ${event.type}${dataStr}`;

    // 用 console.error 输出（避免干扰 stdout 的流式输出）
    if (event.level <= TraceLevel.ERROR) {
      console.error(`\x1b[31m${line}\x1b[0m`);
    } else if (event.level <= TraceLevel.WARN) {
      console.error(`\x1b[33m${line}\x1b[0m`);
    } else {
      console.error(`\x1b[90m${line}\x1b[0m`);
    }
  }

  private writeToFile(event: TraceEvent): void {
    if (!this.filePath) return;
    try {
      appendFileSync(this.filePath, JSON.stringify(event) + '\n');
    } catch {
      // 文件写入失败不应中断业务
    }
  }
}

/**
 * 全局 TraceLogger 实例（惰性初始化）
 */
let globalLogger: TraceLogger | null = null;

/**
 * 获取或创建全局 TraceLogger
 */
export function getTraceLogger(config?: Partial<TraceLoggerConfig>): TraceLogger {
  if (!globalLogger) {
    globalLogger = new TraceLogger(config);
  }
  return globalLogger;
}

/**
 * 重置全局 TraceLogger（测试用）
 */
export function resetTraceLogger(): void {
  if (globalLogger) {
    globalLogger.finalize();
    globalLogger = null;
  }
}
