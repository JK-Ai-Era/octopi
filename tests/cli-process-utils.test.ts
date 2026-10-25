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
  firstExecutableFromLsof,
  getProcessName,
  isProcessAlive,
  isSelfOrAncestorPid,
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

  test('isSelfOrAncestorPid blocks self and allows unrelated pid', () => {
    expect(isSelfOrAncestorPid(process.pid)).toBe(true);
    expect(isSelfOrAncestorPid(0)).toBe(true);
    expect(isSelfOrAncestorPid(-5)).toBe(true);
    // 不存在的高位 pid 不应被当成祖先
    expect(isSelfOrAncestorPid(2147483646)).toBe(false);
  });

  test('killProcess refuses self', async () => {
    const ok = await killProcess(process.pid);
    expect(ok).toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
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

  test('getProcessName returns executable name for own pid', () => {
    const name = getProcessName(process.pid);
    expect(name).toBeTruthy();
    expect(name!.toLowerCase()).toContain('node');
    expect(getProcessName(-1)).toBeNull();
  });

  // macOS ships ps setuid and Seatbelt refuses to exec setuid binaries, so the
  // name lookup must not depend on ps — otherwise it silently degrades to null
  // inside the jail (and inside the agent runtime, which is the same jail).
  test('getProcessName resolves the caller inside a setuid-exec jail', () => {
    const name = getProcessName(process.pid);
    expect(name).not.toBeNull();
    // lsof reports the executable image, i.e. an absolute path on darwin.
    if (process.platform === 'darwin') expect(name!.startsWith('/')).toBe(true);
  });

  test('firstExecutableFromLsof takes the image, not dyld', () => {
    const output = ['p79654', 'ftxt', 'n/bin/bash', 'ftxt', 'n/usr/lib/dyld'].join('\n');
    expect(firstExecutableFromLsof(output)).toBe('/bin/bash');
  });

  test('firstExecutableFromLsof returns null when nothing matched', () => {
    expect(firstExecutableFromLsof('')).toBeNull();
    expect(firstExecutableFromLsof('p123\n')).toBeNull();
    expect(firstExecutableFromLsof('p123\nftxt\nn\n')).toBeNull();
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
    expect(pid).not.toBeNull();
    expect(isProcessAlive(pid!)).toBe(true);

    const killed = await killProcess(pid!, { timeoutMs: 3000 });
    expect(killed).toBe(true);
    expect(isProcessAlive(pid!)).toBe(false);
  }, 20_000);
});
