/**
 * Observability 全面测试
 *
 * 覆盖：级别过滤、文件输出、控制台输出、TraceCollector 集成、边界情况
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceLogger, TraceLevel, TRACE_LEVEL_NAMES, TraceCollector } from '../src/observability/index.js';
import type { TraceEvent } from '../src/observability/index.js';

describe('TraceLogger', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'trace-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── 级别过滤 ──

  describe('level filtering', () => {
    it('should record events at or below configured level', () => {
      const logger = new TraceLogger({ level: TraceLevel.WARN, consoleLevel: null, outputDir: tempDir });

      logger.fatal('e.fatal', {});
      logger.error('e.error', {});
      logger.warn('e.warn', {});
      logger.info('e.info', {});   // 超过 WARN，不应写入文件
      logger.debug('e.debug', {}); // 超过 WARN
      logger.finalize();

      const lines = readTraceLines(tempDir);
      const eventTypes = lines.filter(l => l.type !== 'trace.start' && l.type !== 'trace.end').map(l => l.type);

      expect(eventTypes).toContain('e.fatal');
      expect(eventTypes).toContain('e.error');
      expect(eventTypes).toContain('e.warn');
      expect(eventTypes).not.toContain('e.info');
      expect(eventTypes).not.toContain('e.debug');
    });

    it('should record all events at TRACE level', () => {
      const logger = new TraceLogger({ level: TraceLevel.TRACE, consoleLevel: null, outputDir: tempDir });

      logger.fatal('e0', {});
      logger.error('e1', {});
      logger.warn('e2', {});
      logger.info('e3', {});
      logger.debug('e4', {});
      logger.trace('e5', {});
      logger.finalize();

      const lines = readTraceLines(tempDir);
      const events = lines.filter(l => l.type.startsWith('e'));
      expect(events.length).toBe(6);
    });

    it('should record no events at level -1 (disabled)', () => {
      const logger = new TraceLogger({ level: -1 as TraceLevel, consoleLevel: null, outputDir: tempDir });

      logger.info('test', {});
      logger.error('test', {});
      logger.finalize();

      // 只有 trace.start 和 trace.end（它们不受 level 过滤）
      const lines = readTraceLines(tempDir);
      expect(lines.length).toBe(2);
    });
  });

  // ── 文件输出 ──

  describe('file output', () => {
    it('should create JSONL file with correct format', () => {
      const logger = new TraceLogger({ level: TraceLevel.INFO, consoleLevel: null, outputDir: tempDir });

      logger.info('test.event', { key: 'value', num: 42 });
      logger.finalize();

      const lines = readTraceLines(tempDir);
      expect(lines.length).toBe(3); // trace.start + test.event + trace.end

      const event = lines[1];
      expect(event.ts).toBeTypeOf('number');
      expect(event.level).toBe(TraceLevel.INFO);
      expect(event.type).toBe('test.event');
      expect(event.data.key).toBe('value');
      expect(event.data.num).toBe(42);
    });

    it('should include sessionId and agentId when provided', () => {
      const logger = new TraceLogger({ level: TraceLevel.INFO, consoleLevel: null, outputDir: tempDir });

      logger.info('test', { data: 1 }, { sessionId: 'sess-123', agentId: 'agent-456' });
      logger.finalize();

      const lines = readTraceLines(tempDir);
      const event = lines[1];
      expect(event.sessionId).toBe('sess-123');
      expect(event.agentId).toBe('agent-456');
    });

    it('should write trace.start and trace.end markers', () => {
      const logger = new TraceLogger({ level: TraceLevel.INFO, consoleLevel: null, outputDir: tempDir });
      logger.info('middle', {});
      logger.finalize();

      const lines = readTraceLines(tempDir);
      expect(lines[0].type).toBe('trace.start');
      expect(lines[lines.length - 1].type).toBe('trace.end');
      expect(lines[lines.length - 1].data.eventCount).toBe(1);
      expect(lines[lines.length - 1].data.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should create output directory if it does not exist', () => {
      const nestedDir = join(tempDir, 'a', 'b', 'c');
      const logger = new TraceLogger({ level: TraceLevel.INFO, consoleLevel: null, outputDir: nestedDir });

      logger.info('test', {});
      logger.finalize();

      expect(existsSync(nestedDir)).toBe(true);
      const files = readdirSync(nestedDir).filter(f => f.endsWith('.jsonl'));
      expect(files.length).toBe(1);
    });

    it('should not create file when outputDir is null', () => {
      const logger = new TraceLogger({ level: TraceLevel.INFO, consoleLevel: null, outputDir: null });

      logger.info('test', {});
      logger.finalize();

      expect(logger.getFilePath()).toBeUndefined();
    });
  });

  // ── 控制台输出 ──

  describe('console output', () => {
    it('should not write to console when consoleLevel is null', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const logger = new TraceLogger({ level: TraceLevel.INFO, consoleLevel: null, outputDir: null });
      logger.info('test', {});
      logger.finalize();

      const calls = consoleSpy.mock.calls.map(c => String(c[0]));
      const hasTestEvent = calls.some(c => c.includes('test'));
      expect(hasTestEvent).toBe(false);

      consoleSpy.mockRestore();
    });

    it('should write to console when consoleLevel is set', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const logger = new TraceLogger({ level: TraceLevel.DEBUG, consoleLevel: TraceLevel.WARN, outputDir: null });
      logger.warn('test.warn', { reason: 'test' });
      logger.info('test.info', {}); // 超过 consoleLevel
      logger.finalize();

      const calls = consoleSpy.mock.calls.map(c => String(c[0]));
      const hasWarn = calls.some(c => c.includes('test.warn'));
      const hasInfo = calls.some(c => c.includes('test.info'));

      expect(hasWarn).toBe(true);
      expect(hasInfo).toBe(false);

      consoleSpy.mockRestore();
    });
  });

  // ── EngineEvent 映射 ──

  describe('engine event mapping', () => {
    it('should map engine events to correct trace levels', () => {
      const logger = new TraceLogger({ level: TraceLevel.TRACE, consoleLevel: null, outputDir: tempDir });

      // INFO 级别
      logger.logEngineEvent({ type: 'turn.start', timestamp: Date.now() });
      logger.logEngineEvent({ type: 'model.call.start', timestamp: Date.now() });
      logger.logEngineEvent({ type: 'tool.exec.end', timestamp: Date.now() });

      // ERROR 级别
      logger.logEngineEvent({ type: 'model.call.error', timestamp: Date.now() });
      logger.logEngineEvent({ type: 'security.blocked', timestamp: Date.now() });

      // WARN 级别
      logger.logEngineEvent({ type: 'retry', timestamp: Date.now() });
      logger.logEngineEvent({ type: 'budget.exceeded', timestamp: Date.now() });

      // TRACE 级别
      logger.logEngineEvent({ type: 'llm_stream_delta', timestamp: Date.now() });

      logger.finalize();

      const lines = readTraceLines(tempDir);
      const events = lines.filter(l => l.type !== 'trace.start' && l.type !== 'trace.end');

      expect(events.length).toBe(8);

      // 验证级别映射
      const turnStart = events.find(e => e.type === 'turn.start');
      expect(turnStart?.level).toBe(TraceLevel.INFO);

      const error = events.find(e => e.type === 'model.call.error');
      expect(error?.level).toBe(TraceLevel.ERROR);

      const retry = events.find(e => e.type === 'retry');
      expect(retry?.level).toBe(TraceLevel.WARN);

      const delta = events.find(e => e.type === 'llm_stream_delta');
      expect(delta?.level).toBe(TraceLevel.TRACE);
    });
  });

  // ── 事件计数 ──

  describe('event counting', () => {
    it('should count all events including filtered ones', () => {
      const logger = new TraceLogger({ level: TraceLevel.WARN, consoleLevel: null, outputDir: tempDir });

      logger.info('filtered', {});  // 不写入文件
      logger.warn('recorded', {});  // 写入文件
      logger.error('recorded2', {}); // 写入文件
      logger.finalize();

      // eventCount 计算所有 log() 调用，不管是否被过滤
      expect(logger.getEventCount()).toBe(3);
    });
  });
});

describe('TraceCollector', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'collector-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should wrap engine events and add turn markers', async () => {
    const collector = new TraceCollector({
      level: TraceLevel.INFO,
      consoleLevel: null,
      outputDir: tempDir,
    });

    async function* mockEvents() {
      yield { type: 'model.call.start', timestamp: Date.now(), data: { model: 'test' } };
      yield { type: 'turn.end', timestamp: Date.now(), data: { content: 'hi' } };
    }

    const events: string[] = [];
    for await (const e of collector.wrap(mockEvents(), { sessionId: 's1' })) {
      events.push(e.type);
    }

    expect(events).toEqual(['model.call.start', 'turn.end']);
    collector.finalize();

    const lines = readTraceLines(tempDir);
    const types = lines.map(l => l.type);
    expect(types).toContain('turn.start');
    expect(types).toContain('turn.end');
  });

  it('should record empty response warning', () => {
    const collector = new TraceCollector({
      level: TraceLevel.WARN,
      consoleLevel: null,
      outputDir: tempDir,
    });

    collector.recordEmptyResponse({ sessionId: 's1', messageCount: 5, model: 'test' });
    collector.finalize();

    const lines = readTraceLines(tempDir);
    const emptyEvent = lines.find(l => l.type === 'empty.response');
    expect(emptyEvent).toBeDefined();
    expect(emptyEvent?.data.messageCount).toBe(5);
  });

  it('should record context at DEBUG level', () => {
    const collector = new TraceCollector({
      level: TraceLevel.DEBUG,
      consoleLevel: null,
      outputDir: tempDir,
    });

    collector.recordContext({
      messageCount: 10,
      estimatedTokens: 2500,
      systemPromptLength: 800,
      toolCount: 5,
      sessionId: 's1',
      agentId: 'a1',
    });

    collector.finalize();

    const lines = readTraceLines(tempDir);
    const ctxEvent = lines.find(l => l.type === 'context.built');
    expect(ctxEvent).toBeDefined();
    expect(ctxEvent?.data.messageCount).toBe(10);
    expect(ctxEvent?.data.estimatedTokens).toBe(2500);
  });

  it('should not record context at INFO level', () => {
    const collector = new TraceCollector({
      level: TraceLevel.INFO,
      consoleLevel: null,
      outputDir: tempDir,
    });

    collector.recordContext({ messageCount: 10, estimatedTokens: 2500, systemPromptLength: 800, toolCount: 5 });
    collector.finalize();

    const lines = readTraceLines(tempDir);
    const ctxEvent = lines.find(l => l.type === 'context.built');
    expect(ctxEvent).toBeUndefined();
  });

  it('should record session state', () => {
    const collector = new TraceCollector({
      level: TraceLevel.DEBUG,
      consoleLevel: null,
      outputDir: tempDir,
    });

    collector.recordSessionState({
      sessionId: 's1',
      messageCount: 7,
      turnCount: 3,
      sessionSize: '2.3KB',
      agentId: 'a1',
    });

    collector.finalize();

    const lines = readTraceLines(tempDir);
    const stateEvent = lines.find(l => l.type === 'session.state');
    expect(stateEvent).toBeDefined();
    expect(stateEvent?.data.turnCount).toBe(3);
  });

  it('should record tool context with args', () => {
    const collector = new TraceCollector({
      level: TraceLevel.DEBUG,
      consoleLevel: null,
      outputDir: tempDir,
      captureToolArgs: true,
    });

    collector.recordToolContext({
      toolName: 'file_write',
      cwd: '/workspace',
      args: { path: 'test.txt', content: 'hello' },
    });

    collector.finalize();

    const lines = readTraceLines(tempDir);
    const toolEvent = lines.find(l => l.type === 'tool.exec.context');
    expect(toolEvent).toBeDefined();
    expect(toolEvent?.data.toolName).toBe('file_write');
    expect(toolEvent?.data.cwd).toBe('/workspace');
    expect(toolEvent?.data.args).toEqual({ path: 'test.txt', content: 'hello' });
  });

  it('should exclude tool args when captureToolArgs is false', () => {
    const collector = new TraceCollector({
      level: TraceLevel.DEBUG,
      consoleLevel: null,
      outputDir: tempDir,
      captureToolArgs: false,
    });

    collector.recordToolContext({
      toolName: 'file_write',
      cwd: '/workspace',
      args: { path: 'secret.txt' },
    });

    collector.finalize();

    const lines = readTraceLines(tempDir);
    const toolEvent = lines.find(l => l.type === 'tool.exec.context');
    expect(toolEvent?.data.args).toBeUndefined();
  });

  it('should handle multiple turns in same collector', async () => {
    const collector = new TraceCollector({
      level: TraceLevel.INFO,
      consoleLevel: null,
      outputDir: tempDir,
    });

    // Turn 1
    async function* events1() {
      yield { type: 'model.call.start', timestamp: Date.now(), data: {} };
      yield { type: 'turn.end', timestamp: Date.now(), data: { content: 'a' } };
    }
    for await (const _ of collector.wrap(events1())) { /* consume */ }

    // Turn 2
    async function* events2() {
      yield { type: 'model.call.start', timestamp: Date.now(), data: {} };
      yield { type: 'turn.end', timestamp: Date.now(), data: { content: 'b' } };
    }
    for await (const _ of collector.wrap(events2())) { /* consume */ }

    collector.finalize();

    const lines = readTraceLines(tempDir);
    const turnStarts = lines.filter(l => l.type === 'turn.start');
    expect(turnStarts.length).toBe(2);
    expect(turnStarts[0].data.turnId).toBe('turn_1');
    expect(turnStarts[1].data.turnId).toBe('turn_2');
  });
});

// ── 辅助函数 ──

function readTraceLines(dir: string): TraceEvent[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  if (files.length === 0) return [];

  const content = readFileSync(join(dir, files[0]), 'utf-8');
  return content.split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as TraceEvent);
}
