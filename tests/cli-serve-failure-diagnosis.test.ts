/**
 * serve start 失败路径：日志尾读取 + 人话诊断映射
 *
 * 契约：任何启动失败都必须给出
 *   原因（从子进程日志翻译） + 出路（下一步命令） + 证据位置（日志/前台调试）
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  diagnoseStartupFailure,
  readLogTail,
  getGatewayLogPath,
  readKnowledgeLinesSince,
  waitForKnowledgeLines,
} from '../src/cli/daemon.js';

let tempDir: string;
let logPath: string;
let prevHome: string | undefined;

beforeEach(() => {
  tempDir = join(tmpdir(), `octopi-diagnose-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  logPath = join(tempDir, 'gateway.log');
  prevHome = process.env.OCTOPI_HOME;
  process.env.OCTOPI_HOME = tempDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.OCTOPI_HOME;
  else process.env.OCTOPI_HOME = prevHome;
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe('getGatewayLogPath', () => {
  test('lives under OCTOPI_HOME/logs/gateway.log', () => {
    expect(getGatewayLogPath()).toBe(join(tempDir, 'logs', 'gateway.log'));
  });
});

describe('readLogTail', () => {
  test('missing file returns empty array', () => {
    expect(readLogTail(join(tempDir, 'nope.log'))).toEqual([]);
  });

  test('returns last non-empty lines up to maxLines', () => {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, 'line1\n\nline2\nline3\nline4\n', 'utf-8');
    expect(readLogTail(logPath, 2)).toEqual(['line3', 'line4']);
    expect(readLogTail(logPath)).toHaveLength(4);
  });
});

describe('readKnowledgeLinesSince', () => {
  const marker = '--- octopi serve start 2026-10-08T18:07:31.397Z port=18180 ---';

  test('excludes [Knowledge] lines from previous runs (appended log)', () => {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(
      logPath,
      [
        '[Knowledge] manageLocal child started (port=18280, pid=1)',
        '[Knowledge] state=ready',
        '',
        marker,
        '[config] Loading config',
        '[HTTP Adapter] Listening on 127.0.0.1:18180',
      ].join('\n'),
      'utf-8',
    );
    expect(readKnowledgeLinesSince(logPath, marker)).toEqual([]);
  });

  test('returns only [Knowledge] lines after the current start marker', () => {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(
      logPath,
      [
        '[Knowledge] stale from previous run',
        marker,
        '[HTTP Adapter] Listening on 127.0.0.1:18180',
        '[Knowledge] manageLocal child started (port=18280, pid=2)',
        '[Knowledge] state=ready',
      ].join('\n'),
      'utf-8',
    );
    expect(readKnowledgeLinesSince(logPath, marker)).toEqual([
      '[Knowledge] manageLocal child started (port=18280, pid=2)',
      '[Knowledge] state=ready',
    ]);
  });

  test('missing file returns empty array', () => {
    expect(readKnowledgeLinesSince(join(tempDir, 'nope.log'), marker)).toEqual([]);
  });
});

describe('waitForKnowledgeLines', () => {
  const marker = '--- octopi serve start 2026-10-08T18:07:31.397Z port=18180 ---';

  test('returns once a terminal [Knowledge] line appears (startup race)', async () => {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${marker}\n[HTTP Adapter] Listening\n`, 'utf-8');

    // 模拟 Knowledge 在端口就绪后才写日志
    setTimeout(() => {
      writeFileSync(
        logPath,
        `${marker}\n[HTTP Adapter] Listening\n[Knowledge] state=ready\n`,
        'utf-8',
      );
    }, 150);

    const lines = await waitForKnowledgeLines(logPath, marker, 2_000);
    expect(lines.some((l) => l.includes('state=ready'))).toBe(true);
  });

  test('times out with partial/empty lines when Knowledge never logs', async () => {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${marker}\n[HTTP Adapter] Listening\n`, 'utf-8');

    const lines = await waitForKnowledgeLines(logPath, marker, 250);
    expect(lines).toEqual([]);
  });
});

describe('diagnoseStartupFailure', () => {
  const base = { port: 18180, configPath: undefined, logPath: '/home/u/.octopi/logs/gateway.log' };

  test('EADDRINUSE → 端口被抢 + 重试/换端口出路', () => {
    const lines = diagnoseStartupFailure({
      ...base,
      logTail: ['Error: listen EADDRINUSE: address already in use 127.0.0.1:18180'],
    }).join('\n');
    expect(lines).toContain('EADDRINUSE');
    expect(lines).toContain('18180');
    expect(lines).toContain('octopi serve start');
    expect(lines).toContain('--port');
    expect(lines).toContain('Full log:');
    expect(lines).toContain('Foreground debug:');
  });

  test('module not found → 重装出路', () => {
    const lines = diagnoseStartupFailure({
      ...base,
      logTail: ["Error: Cannot find module '@octopi-agent/engine/xxx.js'"],
    }).join('\n');
    expect(lines).toContain('installation may be incomplete');
    expect(lines).toContain('npm install');
  });

  test('config not found → init 出路', () => {
    const lines = diagnoseStartupFailure({
      ...base,
      logPath: '/x/gateway.log',
      logTail: ['Error: Config file not found. Searched:', '  1. ./octopi.json'],
    }).join('\n');
    expect(lines).toContain('Config file not found');
    expect(lines).toContain('octopi init');
  });

  test('config invalid → 指出配置文件', () => {
    const lines = diagnoseStartupFailure({
      ...base,
      configPath: '/etc/octopi/octopi.json',
      logTail: ['Error: Config validation failed:', '  agents.0.model: required'],
    }).join('\n');
    expect(lines).toContain('Configuration is invalid: /etc/octopi/octopi.json');
    expect(lines).toContain('Fix the field');
  });

  test('unknown error → 原样展示日志尾部', () => {
    const lines = diagnoseStartupFailure({
      ...base,
      logTail: ['weird stack line A', 'weird stack line B'],
    });
    expect(lines.join('\n')).toContain('weird stack line A');
    expect(lines.join('\n')).toContain('weird stack line B');
  });

  test('empty log → 明说没有输出，仍给出证据位置', () => {
    const lines = diagnoseStartupFailure({ ...base, logTail: [] }).join('\n');
    expect(lines).toContain('log is empty');
    expect(lines).toContain('Full log:');
    expect(lines).toContain('octopi serve fg');
  });

  test('every branch ends with log path and foreground debug hint', () => {
    const cases = [
      { logTail: ['EADDRINUSE'] },
      { logTail: ['Cannot find module x'] },
      { logTail: ['Config file not found'] },
      { logTail: ['Config validation failed'] },
      { logTail: ['random'] },
      { logTail: [] as string[] },
    ];
    for (const c of cases) {
      const out = diagnoseStartupFailure({ ...base, ...c });
      expect(out.join('\n')).toContain(`Full log: ${base.logPath}`);
      expect(out.join('\n')).toContain('octopi serve fg');
    }
  });
});
