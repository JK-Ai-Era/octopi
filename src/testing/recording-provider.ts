/**
 * Recording Provider — 录制真实 LLM 交互
 *
 * 包装真实的 ModelProvider，录制所有请求和响应。
 * 录制数据保存为 JSONL 文件，用于回放测试。
 */

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from '../core/interfaces/model-provider.js';

/** 录制条目 */
export interface RecordingEntry {
  /** 序号 */
  index: number;
  /** 时间戳 */
  ts: number;
  /** 请求摘要 */
  request: {
    model?: string;
    messageCount: number;
    toolCount: number;
    systemPromptLength: number;
  };
  /** 完整请求（可选，默认不记录以节省空间） */
  requestFull?: LLMRequest;
  /** 响应 */
  response: LLMResponse;
  /** 流式 chunks */
  streamChunks?: LLMStreamChunk[];
  /** 耗时 */
  durationMs: number;
}

/** 录制配置 */
export interface RecordingConfig {
  /** 录制输出目录 */
  outputDir: string;
  /** 场景名称 */
  scenarioName: string;
  /** 是否记录完整请求（可能很大） */
  captureFullRequest?: boolean;
  /** 是否记录流式 chunks */
  captureStreamChunks?: boolean;
}

/**
 * RecordingProvider — 包装真实 provider，录制所有交互
 */
export class RecordingProvider implements ModelProvider {
  readonly name: string;
  private inner: ModelProvider;
  private config: RecordingConfig;
  private entries: RecordingEntry[] = [];
  private index = 0;
  private filePath: string;

  constructor(inner: ModelProvider, config: RecordingConfig) {
    this.inner = inner;
    this.config = {
      captureFullRequest: false,
      captureStreamChunks: true,
      ...config,
    };
    this.name = `recording(${inner.name})`;

    // 准备输出目录
    if (!existsSync(config.outputDir)) {
      mkdirSync(config.outputDir, { recursive: true });
    }
    this.filePath = join(config.outputDir, `${config.scenarioName}.jsonl`);
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();
    const response = await this.inner.chat(request);
    const durationMs = Date.now() - start;

    this.recordEntry(request, response, durationMs);
    return response;
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    const start = Date.now();
    const chunks: LLMStreamChunk[] = [];
    let response: LLMResponse | null = null;

    for await (const chunk of this.inner.stream(request)) {
      chunks.push(chunk);

      // 收集最终响应
      if (chunk.type === 'done') {
        // 从 chunks 重建响应
        response = this.rebuildResponse(chunks);
      }

      yield chunk;
    }

    const durationMs = Date.now() - start;

    // 如果没有 done chunk，用最后的状态
    if (!response) {
      response = this.rebuildResponse(chunks);
    }

    this.recordEntry(request, response, durationMs, this.config.captureStreamChunks ? chunks : undefined);
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  /**
   * 获取录制文件路径
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * 获取录制条目数
   */
  getEntryCount(): number {
    return this.entries.length;
  }

  /**
   * 获取录制数据（用于保存 manifest）
   */
  getEntries(): RecordingEntry[] {
    return [...this.entries];
  }

  // ── 内部方法 ──

  private recordEntry(
    request: LLMRequest,
    response: LLMResponse,
    durationMs: number,
    streamChunks?: LLMStreamChunk[],
  ): void {
    const entry: RecordingEntry = {
      index: this.index++,
      ts: Date.now(),
      request: {
        model: request.model,
        messageCount: request.messages.length,
        toolCount: request.tools?.length ?? 0,
        systemPromptLength: request.messages.find(m => m.role === 'system')?.content?.length ?? 0,
      },
      response,
      durationMs,
    };

    if (this.config.captureFullRequest) {
      entry.requestFull = request;
    }

    if (streamChunks) {
      entry.streamChunks = streamChunks;
    }

    this.entries.push(entry);

    // 追加到文件
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
    } catch {
      // 写入失败不中断
    }
  }

  /**
   * 从流式 chunks 重建 LLMResponse
   */
  private rebuildResponse(chunks: LLMStreamChunk[]): LLMResponse {
    let content = '';
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    const toolCallBuffers = new Map<number, { id: string; name: string; argsBuffer: string }>();
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

    for (const chunk of chunks) {
      if (chunk.type === 'content' && chunk.content) {
        content += chunk.content;
      }
      if (chunk.type === 'tool_call' && chunk.toolCall) {
        const tc = chunk.toolCall;
        const idx = tc.index ?? 0;
        const existing = toolCallBuffers.get(idx);
        if (existing) {
          if (tc.id) existing.id = tc.id;
          if (tc.name) existing.name = tc.name;
          if (tc.arguments) existing.argsBuffer += tc.arguments;
        } else {
          toolCallBuffers.set(idx, {
            id: tc.id ?? `call_${idx}`,
            name: tc.name ?? '',
            argsBuffer: tc.arguments ?? '',
          });
        }
      }
      if (chunk.type === 'done' && chunk.usage) {
        usage = chunk.usage;
      }
    }

    for (const [, buf] of toolCallBuffers) {
      toolCalls.push({
        id: buf.id,
        name: buf.name,
        arguments: (() => { try { return JSON.parse(buf.argsBuffer); } catch { return {}; } })(),
      });
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      model: 'recorded',
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }
}
