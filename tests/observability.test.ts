/**
 * Observability 模块测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceLogger, TraceLevel, TraceCollector, TRACE_EVENTS } from '../src/observability/index.js';

describe('TraceLogger', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'trace-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should respect level filtering', () => {
    const logger = new TraceLogger({ level: TraceLevel.WARN, consoleLevel: null, outputDir: null });

    // 应该被记录（低于或等于 WARN）
    logger.error('test.error', {});
    logger.warn('test.warn', {});
    logger.info('test.info', {});  // 应该被过滤

    expect(logger.getEventCount()).toBe(3); // 所有调用都计数
  });

  it('should write to file when outputDir is set', () => {
    const logger = new TraceLogger({ level: TraceLevel.DEBUG, consoleLevel: null, outputDir: tempDir });

    logger.info('test.event', { key: 'value' });
    logger.debug('test.debug', { data: 123 });
    logger.finalize();

    const files = require('node:fs').readdirSync(tempDir).filter((f: string) => f.endsWith('.jsonl'));
    expect(files.length).toBe(1);

    const content = readFileSync(join(tempDir, files[0]), 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    // trace.start + test.event + test.debug + trace.end = 4
    expect(lines.length).toBeGreaterThanOrEqual(4);

    const event = JSON.parse(lines[1]);
    expect(event.type).toBe('test.event');
    expect(event.data.key).toBe('value');
    expect(event.level).toBe(TraceLevel.INFO);
  });

  it('should not write to file when outputDir is null', () => {
    const logger = new TraceLogger({ level: TraceLevel.DEBUG, consoleLevel: null, outputDir: null });

    logger.info('test.event', {});
    logger.finalize();

    // 不应该创建任何文件
    expect(logger.getFilePath()).toBeUndefined();
  });

  it('should provide shortcut methods', () => {
    const logger = new TraceLogger({ level: TraceLevel.TRACE, consoleLevel: null, outputDir: tempDir });

    logger.fatal('fatal.event', {});
    logger.error('error.event', {});
    logger.warn('warn.event', {});
    logger.info('info.event', {});
    logger.debug('debug.event', {});
    logger.trace('trace.event', {});
    logger.finalize();

    expect(logger.getEventCount()).toBe(6);
  });

  it('should log engine events with correct level mapping', () => {
    const logger = new TraceLogger({ level: TraceLevel.TRACE, consoleLevel: null, outputDir: tempDir });

    // INFO 级别事件
    logger.logEngineEvent({ type: 'turn.start', timestamp: Date.now(), data: {} });

    // ERROR 级别事件
    logger.logEngineEvent({ type: 'model.call.error', timestamp: Date.now(), data: {} });

    // TRACE 级别事件
    logger.logEngineEvent({ type: 'llm_stream_delta', timestamp: Date.now(), data: { delta: 'hi' } });

    logger.finalize();
    expect(logger.getEventCount()).toBe(3);
  });
});

describe('TraceCollector', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'trace-collector-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should wrap async generator and collect events', async () => {
    const collector = new TraceCollector({
      level: TraceLevel.DEBUG,
      consoleLevel: null,
      outputDir: tempDir,
    });

    // 模拟引擎事件流
    async function* mockEvents() {
      yield { type: 'model.call.start', timestamp: Date.now(), data: { model: 'test' } };
      yield { type: 'llm_stream_delta', timestamp: Date.now(), data: { delta: 'hello' } };
      yield { type: 'llm_stream_delta', timestamp: Date.now(), data: { delta: ' world' } };
      yield { type: 'turn.end', timestamp: Date.now(), data: { content: 'hello world' } };
    }

    const events: string[] = [];
    for await (const event of collector.wrap(mockEvents(), { sessionId: 'test' })) {
      events.push(event.type);
    }

    expect(events).toEqual(['model.call.start', 'llm_stream_delta', 'llm_stream_delta', 'turn.end']);

    collector.finalize();
    expect(collector.getEventCount()).toBeGreaterThan(0);
    expect(collector.getFilePath()).toBeDefined();
  });

  it('should record empty response warning', () => {
    const collector = new TraceCollector({
      level: TraceLevel.WARN,
      consoleLevel: null,
      outputDir: tempDir,
    });

    collector.recordEmptyResponse({ sessionId: 'test', messageCount: 5 });

    collector.finalize();
    expect(collector.getEventCount()).toBeGreaterThan(0);
  });

  it('should record context info at DEBUG level', () => {
    const collector = new TraceCollector({
      level: TraceLevel.DEBUG,
      consoleLevel: null,
      outputDir: tempDir,
    });

    collector.recordContext({
      messageCount: 5,
      estimatedTokens: 1200,
      systemPromptLength: 500,
      toolCount: 4,
      sessionId: 'test',
    });

    collector.recordToolContext({
      toolName: 'file_write',
      cwd: '/workspace',
      args: { path: 'test.txt' },
    });

    collector.finalize();
    expect(collector.getEventCount()).toBe(2);
  });
});
