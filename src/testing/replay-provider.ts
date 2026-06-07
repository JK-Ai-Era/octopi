/**
 * Replay Provider — 回放录制的 LLM 交互
 *
 * 从录制文件加载数据，按顺序回放响应。
 * 用于确定性回归测试。
 */

import { readFileSync, existsSync } from 'node:fs';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from '../core/interfaces/model-provider.js';
import type { RecordingEntry } from './recording-provider.js';

/** 回放配置 */
export interface ReplayConfig {
  /** 录制文件路径 */
  filePath: string;
  /** 是否模拟流式输出（逐 chunk yield） */
  simulateStream?: boolean;
  /** chunk 之间的模拟延迟（ms） */
  chunkDelayMs?: number;
  /** 请求验证：是否检查请求参数与录制一致 */
  validateRequests?: boolean;
}

/**
 * ReplayProvider — 按录制数据回放响应
 */
export class ReplayProvider implements ModelProvider {
  readonly name = 'replay';
  private entries: RecordingEntry[];
  private index = 0;
  private config: ReplayConfig;

  constructor(config: ReplayConfig) {
    this.config = {
      simulateStream: true,
      chunkDelayMs: 5,
      validateRequests: false,
      ...config,
    };

    if (!existsSync(config.filePath)) {
      throw new Error(`Recording file not found: ${config.filePath}`);
    }

    // 加载录制数据
    const content = readFileSync(config.filePath, 'utf-8');
    this.entries = content.split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as RecordingEntry);

    if (this.entries.length === 0) {
      throw new Error(`Recording file is empty: ${config.filePath}`);
    }
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const entry = this.getNextEntry(request);
    return entry.response;
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    const entry = this.getNextEntry(request);

    if (this.config.simulateStream && entry.streamChunks && entry.streamChunks.length > 0) {
      // 从录制的 chunks 回放
      for (const chunk of entry.streamChunks) {
        if (this.config.chunkDelayMs && this.config.chunkDelayMs > 0) {
          await new Promise(r => setTimeout(r, this.config.chunkDelayMs));
        }
        yield chunk;
      }
    } else {
      // 没有录制 chunks，从 response 生成
      if (entry.response.content) {
        // 分块输出
        const content = entry.response.content;
        const chunkSize = 20;
        for (let i = 0; i < content.length; i += chunkSize) {
          if (this.config.chunkDelayMs && this.config.chunkDelayMs > 0) {
            await new Promise(r => setTimeout(r, this.config.chunkDelayMs));
          }
          yield { type: 'content', content: content.substring(i, i + chunkSize) };
        }
      }

      // 工具调用
      if (entry.response.toolCalls) {
        for (const tc of entry.response.toolCalls) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
              index: 0,
            },
          };
        }
      }

      yield { type: 'done', usage: entry.response.usage };
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.index < this.entries.length;
  }

  /**
   * 获取剩余可回放条目数
   */
  getRemainingCount(): number {
    return this.entries.length - this.index;
  }

  /**
   * 获取总条目数
   */
  getTotalCount(): number {
    return this.entries.length;
  }

  /**
   * 重置回放位置
   */
  reset(): void {
    this.index = 0;
  }

  // ── 内部方法 ──

  private getNextEntry(request: LLMRequest): RecordingEntry {
    if (this.index >= this.entries.length) {
      throw new Error(
        `ReplayProvider: no more recorded entries (requested index ${this.index}, total ${this.entries.length}). ` +
        `This means the test sent more LLM requests than were recorded.`
      );
    }

    const entry = this.entries[this.index++];

    // 可选：验证请求参数
    if (this.config.validateRequests) {
      this.validateRequest(request, entry);
    }

    return entry;
  }

  private validateRequest(request: LLMRequest, entry: RecordingEntry): void {
    const issues: string[] = [];

    if (request.model !== entry.request.model) {
      issues.push(`model mismatch: expected "${entry.request.model}", got "${request.model}"`);
    }

    if (request.messages.length !== entry.request.messageCount) {
      issues.push(`message count mismatch: expected ${entry.request.messageCount}, got ${request.messages.length}`);
    }

    if (issues.length > 0) {
      console.warn(`[ReplayProvider] Request validation issues at index ${this.index - 1}:`, issues);
    }
  }
}

/**
 * 从录制文件创建回放 provider（快捷函数）
 */
export function createReplayProvider(filePath: string, config?: Partial<ReplayConfig>): ReplayProvider {
  return new ReplayProvider({ filePath, ...config });
}
