/**
 * CLI 跨平台进程原语测试
 */

import { describe, test, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import {
  delay,
  findPidOnPort,
  isProcessAlive,
  killProcess,
  resolveViteLaunch,
  spawnDetached,
} from '../src/cli/process-utils.js';

describe('process-utils', () => {
  test('delay resolves after ms', async () => {
    const t0 = Date.now();
    await delay(50);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
  });

  test('isProcessAlive is true for self and false for absurd pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  test('findPidOnPort finds listener and ignores free port', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('expected TCP address');
    }
    const port = address.port;

    // 自身监听时应排除 process.pid；允许返回 null 或其它占用者
    const found = findPidOnPort(port);
    expect(found === null || found !== process.pid).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));

    // 关闭后再查，大概率为空（或被系统快速复用，故只断言不崩溃）
    expect(() => findPidOnPort(port)).not.toThrow();
  });

  test('resolveViteLaunch prefers vite.js entry', () => {
    const dir = join(tmpdir(), `octopi-vite-${Date.now()}`);
    const viteDir = join(dir, 'node_modules', 'vite', 'bin');
    mkdirSync(viteDir, { recursive: true });
    writeFileSync(join(viteDir, 'vite.js'), '// stub\n', 'utf-8');

    try {
      const launch = resolveViteLaunch(dir);
      expect(launch).not.toBeNull();
      expect(launch!.command).toBe(process.execPath);
      expect(launch!.args[0]!.endsWith('vite.js')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolveViteLaunch returns null when vite missing', () => {
    const dir = join(tmpdir(), `octopi-novite-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      expect(resolveViteLaunch(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('spawnDetached + killProcess roundtrip', async () => {
    const pid = spawnDetached(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ]);
    expect(pid).toBeTypeOf('number');
    expect(isProcessAlive(pid!)).toBe(true);

    const stopped = await killProcess(pid!, { timeoutMs: 2000 });
    expect(stopped).toBe(true);
    expect(isProcessAlive(pid!)).toBe(false);
  });
});
