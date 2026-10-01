/**
 * CLI Web UI 目录探测 / PID 文件测试
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createTcpServer } from 'node:net';
import {
  findWebDist,
  readWebUiPidFile,
  readWebUiPidRecord,
  writeWebUiPidFile,
  removeWebUiPidFile,
  getWebUiPidPath,
} from '../src/cli/helpers.js';
import { resolveWebUiPort, findPidOnVitePorts } from '../src/cli/webui.js';
import { WebConfigSchema } from '../src/config-schema/webui.js';
import { spawnDetached, killProcess, findPidOnPort, delay } from '../src/cli/process-utils.js';

let tempDir: string;
let prevWebDirEnv: string | undefined;

function writeFakeWeb(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>web</title>');
}

beforeEach(() => {
  tempDir = join(tmpdir(), `octopi-webui-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  prevWebDirEnv = process.env.OCTOPI_WEB_DIR;
  delete process.env.OCTOPI_WEB_DIR;
  removeWebUiPidFile();
});

afterEach(() => {
  if (prevWebDirEnv === undefined) delete process.env.OCTOPI_WEB_DIR;
  else process.env.OCTOPI_WEB_DIR = prevWebDirEnv;
  removeWebUiPidFile();
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe('findWebDist', () => {
  test('prefers OCTOPI_WEB_DIR', () => {
    const envWeb = join(tempDir, 'env-web');
    const configWeb = join(tempDir, 'config-web');
    writeFakeWeb(envWeb);
    writeFakeWeb(configWeb);
    process.env.OCTOPI_WEB_DIR = envWeb;

    const found = findWebDist(undefined, configWeb);
    expect(found).toBe(envWeb);
  });

  test('uses config web.dir when env unset', () => {
    const configWeb = join(tempDir, 'from-config');
    writeFakeWeb(configWeb);
    expect(findWebDist(undefined, configWeb)).toBe(configWeb);
  });

  test('uses config file sibling web/', () => {
    const home = join(tempDir, 'octopi-home');
    const web = join(home, 'web');
    writeFakeWeb(web);
    const configPath = join(home, 'octopi.json');
    writeFileSync(configPath, JSON.stringify({ agents: [], models: {} }));

    expect(findWebDist(configPath)).toBe(web);
  });

  test('accepts package root with dist/index.html', () => {
    const pkg = join(tempDir, 'webui-pkg');
    writeFakeWeb(join(pkg, 'dist'));
    process.env.OCTOPI_WEB_DIR = pkg;
    expect(findWebDist()).toBe(join(pkg, 'dist'));
  });

  test('returns null when nothing matches', () => {
    const emptyConfigDir = join(tempDir, 'empty-home');
    mkdirSync(emptyConfigDir, { recursive: true });
    process.env.OCTOPI_WEB_DIR = join(tempDir, 'does-not-exist');
    expect(() => findWebDist(join(emptyConfigDir, 'octopi.json'), join(tempDir, 'missing-dir'))).not.toThrow();
  });
});

describe('webui pid file', () => {
  test('writes JSON and reads back pid + dir', () => {
    writeWebUiPidFile(4242, { dir: 'C:\\fake\\web' });
    const record = readWebUiPidRecord();
    expect(record?.pid).toBe(4242);
    expect(record?.dir).toBe('C:\\fake\\web');
    expect(record?.startedAt).toBeTruthy();
    expect(readWebUiPidFile()).toBe(4242);

    const raw = readFileSync(getWebUiPidPath(), 'utf-8');
    expect(raw.trim().startsWith('{')).toBe(true);
  });

  test('reads legacy plain-number pid file', () => {
    writeFileSync(getWebUiPidPath(), '99999\n');
    expect(readWebUiPidRecord()).toEqual({ pid: 99999 });
    expect(readWebUiPidFile()).toBe(99999);
  });

  test('returns null for corrupt pid file', () => {
    writeFileSync(getWebUiPidPath(), 'not-a-pid');
    expect(readWebUiPidRecord()).toBeNull();
    expect(readWebUiPidFile()).toBeNull();
  });
});

describe('WebConfigSchema web.port', () => {
  test('accepts valid port and rejects out-of-range', () => {
    expect(WebConfigSchema.safeParse({ port: 9000 }).success).toBe(true);
    expect(WebConfigSchema.safeParse({ port: 8180 }).success).toBe(true);
    expect(WebConfigSchema.safeParse({ port: 0 }).success).toBe(false);
    expect(WebConfigSchema.safeParse({ port: 70000 }).success).toBe(false);
    expect(WebConfigSchema.safeParse({ port: 1.5 }).success).toBe(false);
    expect(WebConfigSchema.safeParse({ port: '9000' }).success).toBe(false);
  });
});

describe('resolveWebUiPort', () => {
  function writeConfig(web: Record<string, unknown>): string {
    const p = join(tempDir, 'octopi.json');
    writeFileSync(p, JSON.stringify({ web }, null, 2));
    return p;
  }

  test('CLI --port overrides config and default', () => {
    const configPath = writeConfig({ port: 9000 });
    expect(resolveWebUiPort(configPath, 7000)).toBe(7000);
  });

  test('config web.port beats default', () => {
    const configPath = writeConfig({ port: 9000 });
    expect(resolveWebUiPort(configPath)).toBe(9000);
    expect(resolveWebUiPort(configPath, NaN)).toBe(9000);
  });

  test('falls back to 8180 when config absent', () => {
    const configPath = join(tempDir, 'empty.json');
    writeFileSync(configPath, '{}');
    expect(resolveWebUiPort(configPath)).toBe(8180);
  });

  test('ignores invalid override / config port', () => {
    const configPath = writeConfig({ port: 70000 });
    expect(resolveWebUiPort(configPath)).toBe(8180);
    expect(resolveWebUiPort(configPath, 0)).toBe(8180);
    expect(resolveWebUiPort(configPath, -1)).toBe(8180);
    expect(resolveWebUiPort(configPath, NaN)).toBe(8180);
  });
});

describe('findPidOnVitePorts', () => {
  test('prefers expected custom port over legacy ports', async () => {
    // 拿一个空闲端口（环境里可能同时有旧 5173 实例，期望端口必须优先命中）
    const probe = createTcpServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const addr = probe.address();
    if (typeof addr === 'string' || addr === null) throw new Error('expected port');
    const port = addr.port;
    await new Promise<void>((r) => probe.close(() => r()));

    const childPid = spawnDetached(process.execPath, [
      '-e',
      `require('net').createServer(() => {}).listen(${port}, '127.0.0.1')`,
    ]);
    expect(childPid).not.toBeNull();
    try {
      let ready = false;
      for (let i = 0; i < 25 && !ready; i++) {
        ready = findPidOnPort(port) === childPid;
        if (!ready) await delay(200);
      }
      expect(ready).toBe(true);

      const hit = findPidOnVitePorts(port);
      expect(hit).toEqual({ pid: childPid, port });
    } finally {
      await killProcess(childPid!, { timeoutMs: 3000 });
    }
  }, 30_000);
});
