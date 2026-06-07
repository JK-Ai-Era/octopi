/**
 * Testing 模块测试（录制回放）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RecordingProvider } from '../src/testing/recording-provider.js';
import { ReplayProvider, createReplayProvider } from '../src/testing/replay-provider.js';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from '../src/core/interfaces/model-provider.js';

// ── Mock Provider ──

class MockProvider implements ModelProvider {
  readonly name = 'mock';
  private responses: LLMResponse[];
  private index = 0;

  constructor(responses: LLMResponse[]) {
    this.responses = responses;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    return this.responses[this.index++ % this.responses.length];
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    const response = this.responses[this.index++ % this.responses.length];

    if (response.content) {
      // 分块输出
      const words = response.content.split(' ');
      for (const word of words) {
        yield { type: 'content', content: word + ' ' };
        await new Promise(r => setTimeout(r, 1));
      }
    }

    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
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

    yield { type: 'done', usage: response.usage };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

// ── 测试 ──

describe('RecordingProvider', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recording-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should record chat interactions', async () => {
    const mock = new MockProvider([
      { content: 'Hello!', model: 'test', finishReason: 'stop' },
    ]);

    const recorder = new RecordingProvider(mock, {
      outputDir: tempDir,
      scenarioName: 'test-chat',
    });

    const response = await recorder.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'test',
    });

    expect(response.content).toBe('Hello!');
    expect(recorder.getEntryCount()).toBe(1);
    expect(existsSync(recorder.getFilePath())).toBe(true);

    // 验证录制文件
    const content = readFileSync(recorder.getFilePath(), 'utf-8');
    const entry = JSON.parse(content.split('\n')[0]);
    expect(entry.response.content).toBe('Hello!');
    expect(entry.request.messageCount).toBe(1);
  });

  it('should record stream interactions', async () => {
    const mock = new MockProvider([
      { content: 'Hello World', model: 'test', finishReason: 'stop' },
    ]);

    const recorder = new RecordingProvider(mock, {
      outputDir: tempDir,
      scenarioName: 'test-stream',
      captureStreamChunks: true,
    });

    let content = '';
    for await (const chunk of recorder.stream({
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'test',
    })) {
      if (chunk.type === 'content' && chunk.content) {
        content += chunk.content;
      }
    }

    expect(content.trim()).toContain('Hello');
    expect(recorder.getEntryCount()).toBe(1);
  });

  it('should record multiple interactions', async () => {
    const mock = new MockProvider([
      { content: 'First', model: 'test', finishReason: 'stop' },
      { content: 'Second', model: 'test', finishReason: 'stop' },
    ]);

    const recorder = new RecordingProvider(mock, {
      outputDir: tempDir,
      scenarioName: 'test-multi',
    });

    await recorder.chat({ messages: [{ role: 'user', content: 'A' }], model: 'test' });
    await recorder.chat({ messages: [{ role: 'user', content: 'B' }], model: 'test' });

    expect(recorder.getEntryCount()).toBe(2);

    // 验证文件中有两行
    const content = readFileSync(recorder.getFilePath(), 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    expect(lines.length).toBe(2);
  });
});

describe('ReplayProvider', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'replay-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should replay recorded chat responses', async () => {
    // 先录制
    const mock = new MockProvider([
      { content: 'Recorded response', model: 'test', finishReason: 'stop' },
    ]);

    const recorder = new RecordingProvider(mock, {
      outputDir: tempDir,
      scenarioName: 'replay-test',
      captureStreamChunks: true,
    });

    await recorder.chat({
      messages: [{ role: 'user', content: 'Test' }],
      model: 'test',
    });

    // 回放
    const replayer = createReplayProvider(recorder.getFilePath(), { simulateStream: false });

    const response = await replayer.chat({
      messages: [{ role: 'user', content: 'Test' }],
      model: 'test',
    });

    expect(response.content).toBe('Recorded response');
    expect(replayer.getRemainingCount()).toBe(0);
  });

  it('should replay recorded stream responses', async () => {
    // 先录制
    const mock = new MockProvider([
      { content: 'Streamed response', model: 'test', finishReason: 'stop' },
    ]);

    const recorder = new RecordingProvider(mock, {
      outputDir: tempDir,
      scenarioName: 'replay-stream',
      captureStreamChunks: true,
    });

    // 录制一次
    let recorded = '';
    for await (const chunk of recorder.stream({
      messages: [{ role: 'user', content: 'Test' }],
      model: 'test',
    })) {
      if (chunk.type === 'content' && chunk.content) {
        recorded += chunk.content;
      }
    }

    // 回放
    const replayer = createReplayProvider(recorder.getFilePath(), {
      simulateStream: true,
      chunkDelayMs: 0,
    });

    let replayed = '';
    for await (const chunk of replayer.stream({
      messages: [{ role: 'user', content: 'Test' }],
      model: 'test',
    })) {
      if (chunk.type === 'content' && chunk.content) {
        replayed += chunk.content;
      }
    }

    expect(replayed.trim()).toContain('Streamed');
  });

  it('should throw when replaying more than recorded', async () => {
    const filePath = join(tempDir, 'empty.jsonl');
    writeFileSync(filePath, JSON.stringify({
      index: 0,
      ts: Date.now(),
      request: { messageCount: 1, toolCount: 0, systemPromptLength: 0 },
      response: { content: 'Only one', model: 'test', finishReason: 'stop' },
      durationMs: 100,
    }) + '\n');

    const replayer = createReplayProvider(filePath, { simulateStream: false });

    // 第一次成功
    await replayer.chat({ messages: [{ role: 'user', content: 'A' }], model: 'test' });

    // 第二次应该抛错
    await expect(
      replayer.chat({ messages: [{ role: 'user', content: 'B' }], model: 'test' }),
    ).rejects.toThrow('no more recorded entries');
  });

  it('should report remaining count', async () => {
    const filePath = join(tempDir, 'count.jsonl');
    const entries = [
      { index: 0, ts: Date.now(), request: { messageCount: 1, toolCount: 0, systemPromptLength: 0 }, response: { content: 'A', model: 'test', finishReason: 'stop' }, durationMs: 10 },
      { index: 1, ts: Date.now(), request: { messageCount: 1, toolCount: 0, systemPromptLength: 0 }, response: { content: 'B', model: 'test', finishReason: 'stop' }, durationMs: 10 },
    ];
    writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    const replayer = createReplayProvider(filePath, { simulateStream: false });

    expect(replayer.getTotalCount()).toBe(2);
    expect(replayer.getRemainingCount()).toBe(2);

    await replayer.chat({ messages: [{ role: 'user', content: 'A' }], model: 'test' });
    expect(replayer.getRemainingCount()).toBe(1);

    await replayer.chat({ messages: [{ role: 'user', content: 'B' }], model: 'test' });
    expect(replayer.getRemainingCount()).toBe(0);
  });
});
