/**
 * Testing 模块全面测试（录制回放 + 场景运行器）
 *
 * 覆盖：录制、回放、工具调用录制、流式录制、场景断言、失败报告
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
  private requestLog: LLMRequest[] = [];

  constructor(responses: LLMResponse[]) {
    this.responses = responses;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    this.requestLog.push(request);
    return this.responses[this.index++ % this.responses.length];
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    this.requestLog.push(request);
    const response = this.responses[this.index++ % this.responses.length];

    if (response.content) {
      for (const char of response.content) {
        yield { type: 'content', content: char };
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

  async isAvailable(): Promise<boolean> { return true; }
  getRequestLog() { return this.requestLog; }
}

// ── RecordingProvider 测试 ──

describe('RecordingProvider', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'rec-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should record chat request/response', async () => {
    const mock = new MockProvider([
      { content: 'Hello', model: 'm', finishReason: 'stop' },
    ]);
    const rec = new RecordingProvider(mock, { outputDir: tempDir, scenarioName: 's1' });

    const resp = await rec.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'm',
    });

    expect(resp.content).toBe('Hello');
    expect(rec.getEntryCount()).toBe(1);

    const file = readFileSync(rec.getFilePath(), 'utf-8');
    const entry = JSON.parse(file.split('\n')[0]);
    expect(entry.response.content).toBe('Hello');
    expect(entry.request.messageCount).toBe(1);
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should record stream chunks when captureStreamChunks=true', async () => {
    const mock = new MockProvider([
      { content: 'AB', model: 'm', finishReason: 'stop' },
    ]);
    const rec = new RecordingProvider(mock, {
      outputDir: tempDir,
      scenarioName: 's2',
      captureStreamChunks: true,
    });

    let content = '';
    for await (const chunk of rec.stream({
      messages: [{ role: 'user', content: 'X' }],
      model: 'm',
    })) {
      if (chunk.type === 'content') content += chunk.content;
    }

    expect(content).toContain('A');
    expect(content).toContain('B');

    const file = readFileSync(rec.getFilePath(), 'utf-8');
    const entry = JSON.parse(file.split('\n')[0]);
    expect(entry.streamChunks).toBeDefined();
    expect(entry.streamChunks.length).toBeGreaterThan(0);
  });

  it('should not record stream chunks when captureStreamChunks=false', async () => {
    const mock = new MockProvider([
      { content: 'Hi', model: 'm', finishReason: 'stop' },
    ]);
    const rec = new RecordingProvider(mock, {
      outputDir: tempDir,
      scenarioName: 's3',
      captureStreamChunks: false,
    });

    for await (const _ of rec.stream({
      messages: [{ role: 'user', content: 'X' }],
      model: 'm',
    })) { /* consume */ }

    const file = readFileSync(rec.getFilePath(), 'utf-8');
    const entry = JSON.parse(file.split('\n')[0]);
    expect(entry.streamChunks).toBeUndefined();
  });

  it('should record tool calls', async () => {
    const mock = new MockProvider([{
      content: '',
      toolCalls: [{ id: 'tc1', name: 'file_read', arguments: { path: '/test' } }],
      model: 'm',
      finishReason: 'tool_calls',
    }]);
    const rec = new RecordingProvider(mock, {
      outputDir: tempDir,
      scenarioName: 's4',
      captureStreamChunks: true,
    });

    for await (const _ of rec.stream({
      messages: [{ role: 'user', content: 'read file' }],
      model: 'm',
    })) { /* consume */ }

    const file = readFileSync(rec.getFilePath(), 'utf-8');
    const entry = JSON.parse(file.split('\n')[0]);
    expect(entry.response.toolCalls).toBeDefined();
    expect(entry.response.toolCalls[0].name).toBe('file_read');
  });

  it('should record full request when captureFullRequest=true', async () => {
    const mock = new MockProvider([
      { content: 'ok', model: 'm', finishReason: 'stop' },
    ]);
    const rec = new RecordingProvider(mock, {
      outputDir: tempDir,
      scenarioName: 's5',
      captureFullRequest: true,
    });

    await rec.chat({
      messages: [{ role: 'user', content: 'test' }],
      model: 'm',
    });

    const file = readFileSync(rec.getFilePath(), 'utf-8');
    const entry = JSON.parse(file.split('\n')[0]);
    expect(entry.requestFull).toBeDefined();
    expect(entry.requestFull.messages).toHaveLength(1);
  });

  it('should record multiple interactions in sequence', async () => {
    const mock = new MockProvider([
      { content: 'A', model: 'm', finishReason: 'stop' },
      { content: 'B', model: 'm', finishReason: 'stop' },
      { content: 'C', model: 'm', finishReason: 'stop' },
    ]);
    const rec = new RecordingProvider(mock, { outputDir: tempDir, scenarioName: 's6' });

    for (let i = 0; i < 3; i++) {
      await rec.chat({
        messages: [{ role: 'user', content: `msg-${i}` }],
        model: 'm',
      });
    }

    expect(rec.getEntryCount()).toBe(3);

    const file = readFileSync(rec.getFilePath(), 'utf-8');
    const lines = file.split('\n').filter(l => l.trim());
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]).index).toBe(0);
    expect(JSON.parse(lines[1]).index).toBe(1);
    expect(JSON.parse(lines[2]).index).toBe(2);
  });
});

// ── ReplayProvider 测试 ──

describe('ReplayProvider', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'replay-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should replay chat response deterministically', async () => {
    // 先录制
    const mock = new MockProvider([
      { content: 'Recorded', model: 'm', finishReason: 'stop' },
    ]);
    const rec = new RecordingProvider(mock, { outputDir: tempDir, scenarioName: 'r1' });
    await rec.chat({ messages: [{ role: 'user', content: 'Q' }], model: 'm' });

    // 回放 3 次，结果应完全一致
    for (let i = 0; i < 3; i++) {
      const replayer = createReplayProvider(rec.getFilePath(), { simulateStream: false });
      const resp = await replayer.chat({ messages: [{ role: 'user', content: 'Q' }], model: 'm' });
      expect(resp.content).toBe('Recorded');
    }
  });

  it('should replay stream chunks', async () => {
    const mock = new MockProvider([
      { content: 'XYZ', model: 'm', finishReason: 'stop' },
    ]);
    const rec = new RecordingProvider(mock, {
      outputDir: tempDir,
      scenarioName: 'r2',
      captureStreamChunks: true,
    });

    // 录制
    for await (const _ of rec.stream({ messages: [{ role: 'user', content: 'Q' }], model: 'm' })) { /* consume */ }

    // 回放
    const replayer = createReplayProvider(rec.getFilePath(), { simulateStream: true, chunkDelayMs: 0 });
    let content = '';
    for await (const chunk of replayer.stream({ messages: [{ role: 'user', content: 'Q' }], model: 'm' })) {
      if (chunk.type === 'content') content += chunk.content;
    }

    expect(content).toContain('X');
    expect(content).toContain('Y');
    expect(content).toContain('Z');
  });

  it('should replay tool calls', async () => {
    const mock = new MockProvider([{
      content: '',
      toolCalls: [{ id: 'tc1', name: 'shell', arguments: { command: 'ls' } }],
      model: 'm',
      finishReason: 'tool_calls',
    }]);
    const rec = new RecordingProvider(mock, { outputDir: tempDir, scenarioName: 'r3', captureStreamChunks: true });

    // 录制
    for await (const _ of rec.stream({ messages: [{ role: 'user', content: 'run ls' }], model: 'm' })) { /* consume */ }

    // 回放
    const replayer = createReplayProvider(rec.getFilePath(), { simulateStream: true, chunkDelayMs: 0 });
    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of replayer.stream({ messages: [{ role: 'user', content: 'run ls' }], model: 'm' })) {
      chunks.push(chunk);
    }

    const toolCallChunk = chunks.find(c => c.type === 'tool_call');
    expect(toolCallChunk).toBeDefined();
    expect(toolCallChunk?.toolCall?.name).toBe('shell');
  });

  it('should throw when exhausted', async () => {
    const filePath = join(tempDir, 'single.jsonl');
    writeFileSync(filePath, JSON.stringify({
      index: 0, ts: Date.now(),
      request: { messageCount: 1, toolCount: 0, systemPromptLength: 0 },
      response: { content: 'only', model: 'm', finishReason: 'stop' },
      durationMs: 10,
    }) + '\n');

    const replayer = createReplayProvider(filePath, { simulateStream: false });

    // 第一次成功
    await replayer.chat({ messages: [{ role: 'user', content: 'A' }], model: 'm' });

    // 第二次抛错
    try {
      await replayer.chat({ messages: [{ role: 'user', content: 'B' }], model: 'm' });
      expect.fail('Should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('no more recorded entries');
    }
  });

  it('should report counts correctly', () => {
    const filePath = join(tempDir, 'multi.jsonl');
    const entries = Array.from({ length: 5 }, (_, i) => JSON.stringify({
      index: i, ts: Date.now(),
      request: { messageCount: 1, toolCount: 0, systemPromptLength: 0 },
      response: { content: `r${i}`, model: 'm', finishReason: 'stop' },
      durationMs: 10,
    }));
    writeFileSync(filePath, entries.join('\n') + '\n');

    const replayer = createReplayProvider(filePath, { simulateStream: false });
    expect(replayer.getTotalCount()).toBe(5);
    expect(replayer.getRemainingCount()).toBe(5);
  });

  it('should reset replay position', async () => {
    const filePath = join(tempDir, 'reset.jsonl');
    writeFileSync(filePath, [
      JSON.stringify({ index: 0, ts: Date.now(), request: { messageCount: 1, toolCount: 0, systemPromptLength: 0 }, response: { content: 'A', model: 'm', finishReason: 'stop' }, durationMs: 10 }),
      JSON.stringify({ index: 1, ts: Date.now(), request: { messageCount: 1, toolCount: 0, systemPromptLength: 0 }, response: { content: 'B', model: 'm', finishReason: 'stop' }, durationMs: 10 }),
    ].join('\n') + '\n');

    const replayer = createReplayProvider(filePath, { simulateStream: false });

    const r1 = await replayer.chat({ messages: [{ role: 'user', content: 'Q' }], model: 'm' });
    expect(r1.content).toBe('A');
    expect(replayer.getRemainingCount()).toBe(1);

    replayer.reset();
    expect(replayer.getRemainingCount()).toBe(2);

    const r2 = await replayer.chat({ messages: [{ role: 'user', content: 'Q' }], model: 'm' });
    expect(r2.content).toBe('A'); // 从头开始
  });

  it('should generate stream chunks from response when no streamChunks recorded', async () => {
    const filePath = join(tempDir, 'no-stream.jsonl');
    writeFileSync(filePath, JSON.stringify({
      index: 0, ts: Date.now(),
      request: { messageCount: 1, toolCount: 0, systemPromptLength: 0 },
      response: { content: 'Hello World', model: 'm', finishReason: 'stop' },
      durationMs: 10,
      // 注意：没有 streamChunks
    }) + '\n');

    const replayer = createReplayProvider(filePath, { simulateStream: true, chunkDelayMs: 0 });
    let content = '';
    for await (const chunk of replayer.stream({ messages: [{ role: 'user', content: 'Q' }], model: 'm' })) {
      if (chunk.type === 'content') content += chunk.content;
    }

    expect(content).toContain('Hello');
    expect(content).toContain('World');
  });

  it('should throw for non-existent file', () => {
    expect(() => createReplayProvider('/nonexistent/file.jsonl')).toThrow('Recording file not found');
  });

  it('should throw for empty file', () => {
    const filePath = join(tempDir, 'empty.jsonl');
    writeFileSync(filePath, '');

    expect(() => createReplayProvider(filePath)).toThrow('Recording file is empty');
  });
});

// ── Round-trip 录制→回放 测试 ──

describe('Round-trip: Record → Replay', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'roundtrip-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('should produce identical responses after record-replay', async () => {
    const responses: LLMResponse[] = [
      { content: 'First response', model: 'm', finishReason: 'stop' },
      { content: 'Second response with more detail', model: 'm', finishReason: 'stop' },
    ];

    // 录制阶段
    const mock = new MockProvider(responses);
    const rec = new RecordingProvider(mock, {
      outputDir: tempDir,
      scenarioName: 'roundtrip',
      captureStreamChunks: true,
    });

    const recordedResponses: string[] = [];
    for (const resp of responses) {
      const r = await rec.chat({
        messages: [{ role: 'user', content: 'test' }],
        model: 'm',
      });
      recordedResponses.push(r.content);
    }

    // 回放阶段
    const replayer = createReplayProvider(rec.getFilePath(), { simulateStream: false });

    for (const expected of recordedResponses) {
      const r = await replayer.chat({
        messages: [{ role: 'user', content: 'test' }],
        model: 'm',
      });
      expect(r.content).toBe(expected);
    }
  });

  it('should preserve usage data through round-trip', async () => {
    const mock = new MockProvider([{
      content: 'test',
      model: 'm',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }]);
    const rec = new RecordingProvider(mock, { outputDir: tempDir, scenarioName: 'usage' });

    await rec.chat({ messages: [{ role: 'user', content: 'Q' }], model: 'm' });

    const replayer = createReplayProvider(rec.getFilePath(), { simulateStream: false });
    const resp = await replayer.chat({ messages: [{ role: 'user', content: 'Q' }], model: 'm' });

    expect(resp.usage).toBeDefined();
    expect(resp.usage?.totalTokens).toBe(15);
  });
});
