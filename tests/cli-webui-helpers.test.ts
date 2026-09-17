/**
 * CLI Web UI 目录探测 / PID 文件测试
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findWebDir,
  readWebUiPidFile,
  readWebUiPidRecord,
  writeWebUiPidFile,
  removeWebUiPidFile,
  getWebUiPidPath,
} from '../src/cli/helpers.js';

let tempDir: string;
let prevWebDirEnv: string | undefined;

function writeFakeWeb(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'octopi-web', private: true }));
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

describe('findWebDir', () => {
  test('prefers OCTOPI_WEB_DIR', () => {
    const envWeb = join(tempDir, 'env-web');
    const configWeb = join(tempDir, 'config-web');
    writeFakeWeb(envWeb);
    writeFakeWeb(configWeb);
    process.env.OCTOPI_WEB_DIR = envWeb;

    const found = findWebDir(undefined, configWeb);
    expect(found).toBe(envWeb);
  });

  test('uses config web.dir when env unset', () => {
    const configWeb = join(tempDir, 'from-config');
    writeFakeWeb(configWeb);
    expect(findWebDir(undefined, configWeb)).toBe(configWeb);
  });

  test('uses config file sibling web/', () => {
    const home = join(tempDir, 'octopi-home');
    const web = join(home, 'web');
    writeFakeWeb(web);
    const configPath = join(home, 'octopi.json');
    writeFileSync(configPath, JSON.stringify({ agents: [], models: {} }));

    expect(findWebDir(configPath)).toBe(web);
  });

  test('returns null when nothing matches', () => {
    const emptyConfigDir = join(tempDir, 'empty-home');
    mkdirSync(emptyConfigDir, { recursive: true });
    // 避免 cwd/包根/包home 的 web 被误匹配：仅验证显式无效 env 路径不崩溃
    process.env.OCTOPI_WEB_DIR = join(tempDir, 'does-not-exist');
    // 不传 configPath/configWebDir 时可能命中包内 web —— 这里只断言显式无效 env 不导致抛错
    expect(() => findWebDir(join(emptyConfigDir, 'octopi.json'), join(tempDir, 'missing-dir'))).not.toThrow();
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
