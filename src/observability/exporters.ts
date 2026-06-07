/**
 * Trace Exporter SPI — 导出接口定义
 *
 * 定义统一的导出协议，让使用者接入任意后端。
 * 框架内置 Console、JsonlFile、Webhook 导出器。
 * 社区可贡献 OpenTelemetry、Prometheus 等导出器。
 */

import type { TraceEvent } from './trace-events.js';

/** 导出器配置基础 */
export interface ExporterConfig {
  /** 导出器类型 */
  type: string;
  /** 导出级别（只导出此级别及以下的事件） */
  level?: number;
}

/**
 * TraceExporter — 导出接口
 *
 * 所有导出器必须实现此接口。
 * 导出器由 TraceLogger 管理，事件自动分发。
 */
export interface TraceExporter {
  /** 导出器名称 */
  readonly name: string;

  /**
   * 导出事件批次
   *
   * 导出器应尽可能异步处理，不阻塞调用方。
   * 如果导出失败，应静默降级（不抛异常影响业务）。
   */
  export(events: TraceEvent[]): Promise<void>;

  /**
   * 刷新缓冲区
   *
   * 某些导出器可能批量发送，此方法强制立即发送。
   */
  flush(): Promise<void>;

  /**
   * 关闭导出器，释放资源
   */
  shutdown(): Promise<void>;
}

// ── 内置导出器：Console ──

export interface ConsoleExporterConfig extends ExporterConfig {
  type: 'console';
  /** 是否使用颜色 */
  color?: boolean;
}

/**
 * Console 导出器 — 输出到 stderr
 */
export class ConsoleExporter implements TraceExporter {
  readonly name = 'console';
  private color: boolean;

  constructor(config?: Partial<ConsoleExporterConfig>) {
    this.color = config?.color ?? true;
  }

  async export(events: TraceEvent[]): Promise<void> {
    for (const event of events) {
      const ts = new Date(event.ts).toISOString().substring(11, 23);
      const level = event.type.padEnd(5);
      let line = `[${ts}] ${level} ${event.type}`;

      if (event.data) {
        const entries = Object.entries(event.data);
        if (entries.length > 0) {
          line += ' ' + entries
            .map(([k, v]) => `${k}=${typeof v === 'string' ? v.substring(0, 60) : JSON.stringify(v)}`)
            .join(' ');
        }
      }

      if (this.color) {
        const colors: Record<number, string> = {
          0: '\x1b[35m', // FATAL - magenta
          1: '\x1b[31m', // ERROR - red
          2: '\x1b[33m', // WARN - yellow
          3: '\x1b[0m',  // INFO - default
          4: '\x1b[90m', // DEBUG - gray
          5: '\x1b[90m', // TRACE - gray
        };
        const reset = '\x1b[0m';
        const color = colors[event.level] ?? '';
        console.error(`${color}${line}${reset}`);
      } else {
        console.error(line);
      }
    }
  }

  async flush(): Promise<void> { /* console 无需 flush */ }
  async shutdown(): Promise<void> { /* console 无需清理 */ }
}

// ── 内置导出器：JsonlFile ──

export interface JsonlFileExporterConfig extends ExporterConfig {
  type: 'jsonl-file';
  /** 输出目录 */
  dir: string;
  /** 文件名前缀 */
  prefix?: string;
}

/**
 * JsonlFile 导出器 — 写入 JSONL 文件
 */
export class JsonlFileExporter implements TraceExporter {
  readonly name = 'jsonl-file';
  private dir: string;
  private prefix: string;
  private filePath?: string;
  private buffer: TraceEvent[] = [];
  private flushInterval?: ReturnType<typeof setInterval>;

  constructor(config: JsonlFileExporterConfig) {
    this.dir = config.dir;
    this.prefix = config.prefix ?? 'trace';

    // 确保目录存在
    const { existsSync, mkdirSync } = require('node:fs');
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }

    // 定期 flush
    this.flushInterval = setInterval(() => { this.flush().catch(() => {}); }, 1000);
  }

  async export(events: TraceEvent[]): Promise<void> {
    this.buffer.push(...events);

    // 缓冲区超过 50 条自动 flush
    if (this.buffer.length >= 50) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const { appendFileSync } = require('node:fs');
    const { join } = require('node:path');

    // 惰性创建文件
    if (!this.filePath) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      this.filePath = join(this.dir, `${this.prefix}-${ts}.jsonl`);
    }

    const lines = this.buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
    this.buffer = [];

    try {
      appendFileSync(this.filePath, lines);
    } catch {
      // 文件写入失败不中断业务
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = undefined;
    }
    await this.flush();
  }

  /** 获取当前 trace 文件路径 */
  getFilePath(): string | undefined {
    return this.filePath;
  }
}

// ── 内置导出器：Webhook ──

export interface WebhookExporterConfig extends ExporterConfig {
  type: 'webhook';
  /** POST 目标 URL */
  url: string;
  /** 自定义 headers */
  headers?: Record<string, string>;
  /** 批量大小（达到此数量自动发送） */
  batchSize?: number;
}

/**
 * Webhook 导出器 — POST 到任意 URL
 */
export class WebhookExporter implements TraceExporter {
  readonly name = 'webhook';
  private url: string;
  private headers: Record<string, string>;
  private batchSize: number;
  private buffer: TraceEvent[] = [];

  constructor(config: WebhookExporterConfig) {
    this.url = config.url;
    this.headers = {
      'Content-Type': 'application/json',
      ...config.headers,
    };
    this.batchSize = config.batchSize ?? 20;
  }

  async export(events: TraceEvent[]): Promise<void> {
    this.buffer.push(...events);

    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = [...this.buffer];
    this.buffer = [];

    try {
      await fetch(this.url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ events: batch, ts: Date.now() }),
      });
    } catch {
      // 网络失败不中断业务
    }
  }

  async shutdown(): Promise<void> {
    await this.flush();
  }
}

// ── 导出器工厂 ──

/** 导出器配置联合类型 */
export type AnyExporterConfig =
  | ConsoleExporterConfig
  | JsonlFileExporterConfig
  | WebhookExporterConfig
  | ExporterConfig;

/**
 * 从配置创建导出器
 */
export function createExporter(config: AnyExporterConfig): TraceExporter {
  switch (config.type) {
    case 'console':
      return new ConsoleExporter(config as ConsoleExporterConfig);
    case 'jsonl-file':
      return new JsonlFileExporter(config as JsonlFileExporterConfig);
    case 'webhook':
      return new WebhookExporter(config as WebhookExporterConfig);
    default:
      throw new Error(`Unknown exporter type: "${config.type}"`);
  }
}
