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
import { resolveWebUiPort, findPidOnVitePorts, readGatewayPort, readGitStatusPollSeconds } from '../src/cli/webui.js';
import { gatewayConfigScript, webConfigScript, webUiServeArgs, resolveGatewayApiKey } from '../src/cli/helpers.js';
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

describe('WebConfigSchema web.gitStatusPollSeconds', () => {
  test('accepts 0..3600 integers (0 = manual) and rejects the rest', () => {
    expect(WebConfigSchema.safeParse({ gitStatusPollSeconds: 5 }).success).toBe(true);
    expect(WebConfigSchema.safeParse({ gitStatusPollSeconds: 0 }).success).toBe(true);
    expect(WebConfigSchema.safeParse({ gitStatusPollSeconds: 3600 }).success).toBe(true);
    expect(WebConfigSchema.safeParse({ gitStatusPollSeconds: -1 }).success).toBe(false);
    expect(WebConfigSchema.safeParse({ gitStatusPollSeconds: 3601 }).success).toBe(false);
    expect(WebConfigSchema.safeParse({ gitStatusPollSeconds: 1.5 }).success).toBe(false);
    expect(WebConfigSchema.safeParse({ gitStatusPollSeconds: '5' }).success).toBe(false);
    // 缺省可选：不配置时前端走内置默认
    expect(WebConfigSchema.safeParse({}).success).toBe(true);
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

describe('gatewayConfigScript（/octopi-config.js 运行时下发）', () => {
  test('serializes port for runtime injection', () => {
    expect(gatewayConfigScript(18180)).toBe('window.__OCTOPI_GATEWAY__={"port":18180};\n');
    expect(gatewayConfigScript(3000)).toContain('"port":3000');
  });

  test('emits null when port absent (frontend falls back to default)', () => {
    expect(gatewayConfigScript(undefined)).toBe('window.__OCTOPI_GATEWAY__=null;\n');
  });
});

describe('readGatewayPort', () => {
  test('reads channels[type=http].port from config', () => {
    const p = join(tempDir, 'gw.json');
    writeFileSync(p, JSON.stringify({ channels: [{ type: 'http', port: 3000, path: '/messages' }] }));
    expect(readGatewayPort(p)).toBe(3000);
  });

  test('returns undefined when channel/port missing or invalid', () => {
    const p = join(tempDir, 'gw-none.json');
    writeFileSync(p, JSON.stringify({ web: { port: 8180 } }));
    expect(readGatewayPort(p)).toBeUndefined();
    writeFileSync(p, JSON.stringify({ channels: [{ type: 'http', port: 70000 }] }));
    expect(readGatewayPort(p)).toBeUndefined();
    expect(readGatewayPort(join(tempDir, 'not-exists.json'))).toBeUndefined();
  });
});

describe('webConfigScript（/octopi-config.js UI 旋钮下发）', () => {
  test('serializes UI knobs for runtime injection', () => {
    expect(webConfigScript({ gitStatusPollSeconds: 10 })).toBe(
      'window.__OCTOPI_WEB__={"gitStatusPollSeconds":10};\n',
    );
    expect(webConfigScript({})).toBe('window.__OCTOPI_WEB__={};\n');
  });

  test('emits null when no knobs (frontend falls back to defaults)', () => {
    expect(webConfigScript(undefined)).toBe('window.__OCTOPI_WEB__=null;\n');
  });
});

describe('readGitStatusPollSeconds', () => {
  test('reads web.gitStatusPollSeconds (0 = manual allowed)', () => {
    const p = join(tempDir, 'poll.json');
    writeFileSync(p, JSON.stringify({ web: { gitStatusPollSeconds: 10 } }));
    expect(readGitStatusPollSeconds(p)).toBe(10);
    writeFileSync(p, JSON.stringify({ web: { gitStatusPollSeconds: 0 } }));
    expect(readGitStatusPollSeconds(p)).toBe(0);
  });

  test('returns undefined when missing or out of range', () => {
    const p = join(tempDir, 'poll-bad.json');
    writeFileSync(p, JSON.stringify({ web: {} }));
    expect(readGitStatusPollSeconds(p)).toBeUndefined();
    writeFileSync(p, JSON.stringify({ web: { gitStatusPollSeconds: 3601 } }));
    expect(readGitStatusPollSeconds(p)).toBeUndefined();
    writeFileSync(p, JSON.stringify({ web: { gitStatusPollSeconds: -1 } }));
    expect(readGitStatusPollSeconds(p)).toBeUndefined();
    writeFileSync(p, JSON.stringify({ web: { gitStatusPollSeconds: 1.5 } }));
    expect(readGitStatusPollSeconds(p)).toBeUndefined();
    writeFileSync(p, JSON.stringify({ web: { gitStatusPollSeconds: '5' } }));
    expect(readGitStatusPollSeconds(p)).toBeUndefined();
    expect(readGitStatusPollSeconds(join(tempDir, 'not-exists.json'))).toBeUndefined();
  });
});

describe('webUiServeArgs（serve-webui argv 拼装）', () => {
  test('0 哨兵必须透传（truthy 判断会把它吞成不下发）', () => {
    expect(webUiServeArgs('/dist', { gitStatusPollSeconds: 0 })).toEqual([
      '/dist',
      '--git-status-poll-seconds',
      '0',
    ]);
  });

  test('缺省不带 flag；全量选项顺序稳定', () => {
    expect(webUiServeArgs('/dist')).toEqual(['/dist']);
    expect(
      webUiServeArgs('/dist', {
        hostArg: '127.0.0.1',
        port: 8180,
        gatewayPort: 18180,
        gitStatusPollSeconds: 10,
      }),
    ).toEqual([
      '/dist',
      '--host',
      '127.0.0.1',
      '--port',
      '8180',
      '--gateway-port',
      '18180',
      '--git-status-poll-seconds',
      '10',
    ]);
  });
});

describe('resolveGatewayApiKey（channels[type=http].apiKey 解析）', () => {
  test('http 通道配置了 apiKey 时原样返回', () => {
    expect(
      resolveGatewayApiKey({ channels: [{ type: 'http', port: 18180, apiKey: 'k-1' }] }),
    ).toBe('k-1');
  });

  test('未配置 / 空串 / 非 http 通道 / 无 channels 均返回 undefined', () => {
    expect(resolveGatewayApiKey({ channels: [{ type: 'http', port: 18180 }] })).toBeUndefined();
    expect(resolveGatewayApiKey({ channels: [{ type: 'http', apiKey: '' }] })).toBeUndefined();
    expect(resolveGatewayApiKey({ channels: [{ type: 'ws', apiKey: 'k-1' }] })).toBeUndefined();
    expect(resolveGatewayApiKey({})).toBeUndefined();
  });
});
