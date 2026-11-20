/**
 * CLI Web UI 目录探测 / PID 文件测试
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createTcpServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import {
  findWebDist,
  readWebUiPidFile,
  readWebUiPidRecord,
  writeWebUiPidFile,
  removeWebUiPidFile,
  getWebUiPidPath,
} from '../src/cli/helpers.js';
import { resolveWebUiPort, findPidOnVitePorts, findUntrackedWebUiInstance, probeWebUiIdentity, probeWebUiState, readGatewayPort, readGitStatusPollSeconds } from '../src/cli/webui.js';
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

describe('probeWebUiIdentity / findUntrackedWebUiInstance（端口认领前的身份验证）', () => {
  /** 起一个返回固定 body 的 HTTP 服务，返回监听端口与关闭句柄 */
  async function serveOnce(body: string, status = 200): Promise<{ port: number; close: () => Promise<void> }> {
    const { createServer } = await import('node:http');
    const srv = createServer((req, res) => {
      if (req.url === '/octopi-config.js') {
        res.writeHead(status, { 'content-type': 'application/javascript' });
        res.end(body);
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const addr = srv.address();
    if (typeof addr === 'string' || addr === null) throw new Error('expected port');
    return { port: addr.port, close: () => new Promise((r) => srv.close(() => r())) };
  }

  test('认领指纹：/octopi-config.js 含 __OCTOPI_GATEWAY__', async () => {
    const s = await serveOnce('window.__OCTOPI_GATEWAY__={"port":18180};\n');
    try {
      expect(await probeWebUiIdentity(s.port)).toBe(true);
    } finally {
      await s.close();
    }
  });

  test('拒绝非 WebUI：无指纹内容 / 404 / 端口无服务', async () => {
    const html = await serveOnce('<!doctype html><title>some website</title>');
    const notFound = await serveOnce('', 404);
    try {
      expect(await probeWebUiIdentity(html.port)).toBe(false);
      expect(await probeWebUiIdentity(notFound.port)).toBe(false);
      // 空闲端口：连接拒绝 → false
      expect(await probeWebUiIdentity(1)).toBe(false);
    } finally {
      await html.close();
      await notFound.close();
    }
  });

  test('findUntrackedWebUiInstance 区分 webui / foreign / 无占用', async () => {
    // findPidOnPort 排除自身进程：照既有模式用 spawnDetached 起外部 HTTP 进程
    async function spawnHttpServer(body: string): Promise<{ pid: number; port: number }> {
      const probe = createTcpServer();
      await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
      const addr = probe.address();
      if (typeof addr === 'string' || addr === null) throw new Error('expected port');
      const port = addr.port;
      await new Promise<void>((r) => probe.close(() => r()));
      const pid = spawnDetached(process.execPath, [
        '-e',
        `require('http').createServer((req,res)=>{res.writeHead(200,{'content-type':'application/javascript'});res.end(${JSON.stringify(body)});}).listen(${port},'127.0.0.1');`,
      ]);
      if (!pid) throw new Error('spawn failed');
      for (let i = 0; i < 25 && findPidOnPort(port) !== pid; i++) await delay(200);
      return { pid, port };
    }

    const webui = await spawnHttpServer('window.__OCTOPI_GATEWAY__=null;\n');
    const foreign = await spawnHttpServer('<!doctype html><title>vite preview</title>');
    try {
      expect(await findUntrackedWebUiInstance(webui.port)).toEqual({ kind: 'webui', pid: webui.pid, port: webui.port });
      expect(await findUntrackedWebUiInstance(foreign.port)).toEqual({ kind: 'foreign', pid: foreign.pid, port: foreign.port });
    } finally {
      await killProcess(webui.pid, { timeoutMs: 3000 });
      await killProcess(foreign.pid, { timeoutMs: 3000 });
    }
  }, 30_000);
});

describe('gatewayConfigScript（/octopi-config.js 运行时下发）', () => {
  test('serializes port for runtime injection', () => {
    expect(gatewayConfigScript({ port: 18180 })).toBe('window.__OCTOPI_GATEWAY__={"port":18180};\n');
    expect(gatewayConfigScript({ port: 3000 })).toContain('"port":3000');
  });

  test('emits null when nothing to inject (frontend falls back to default)', () => {
    expect(gatewayConfigScript()).toBe('window.__OCTOPI_GATEWAY__=null;\n');
    expect(gatewayConfigScript({})).toBe('window.__OCTOPI_GATEWAY__=null;\n');
  });

  test('serializes baseUrl（§7b web.gatewayUrl）and console apiKey（仅本机下发）', () => {
    const out = gatewayConfigScript({ port: 18180, baseUrl: 'https://api.example.com', consoleApiKey: 'sk-console' });
    expect(out).toContain('"baseUrl":"https://api.example.com"');
    expect(out).toContain('"apiKey":"sk-console"');
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

  test('version (AboutPanel) merges into payload; version alone still serializes', () => {
    // 批 3-2：产品版本运行时下发（构建信息非配置），「关于」页不硬编码
    expect(webConfigScript({ gitStatusPollSeconds: 5 }, '0.115.0')).toBe(
      'window.__OCTOPI_WEB__={"gitStatusPollSeconds":5,"version":"0.115.0"};\n',
    );
    expect(webConfigScript(undefined, '0.115.0')).toBe('window.__OCTOPI_WEB__={"version":"0.115.0"};\n');
  });
});

describe('setup 向导链接（批 3-4 旅程：签发单源、显示面共用）', () => {
  test('setupWizardUrl：lan 语义值给占位提示，localhost 直出', async () => {
    const { setupWizardUrl } = await import('../src/cli/helpers.js');
    expect(setupWizardUrl('tok123', 8180, 'lan')).toBe('http://<本机IP>:8180/?setup=tok123');
    expect(setupWizardUrl('tok123', 8180, '0.0.0.0')).toBe('http://<本机IP>:8180/?setup=tok123');
    expect(setupWizardUrl('tok123', 8290, undefined)).toBe('http://localhost:8290/?setup=tok123');
    expect(setupWizardUrl('tok123', 8290, 'local')).toBe('http://localhost:8290/?setup=tok123');
  });

  test('readSetupToken：有效返回 token、过期返回 null、损坏返回 null（不抛）', async () => {
    const { readSetupToken } = await import('../src/cli/helpers.js');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'octopi-tok-'));
    try {
      const now = 1_000_000;
      writeFileSync(join(home, 'setup-token.json'), JSON.stringify({ token: 'abc', expiresAt: now + 60 }));
      expect(readSetupToken(home, now)).toEqual({ token: 'abc', expiresAt: now + 60 });
      expect(readSetupToken(home, now + 120)).toBeNull(); // 过期
      writeFileSync(join(home, 'setup-token.json'), '{broken');
      expect(readSetupToken(home, now)).toBeNull(); // 损坏不抛
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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

describe('m11 裸命令分派前提', () => {
  it('bare-octopi dispatch：parseArgs 不把裸命令归一成 help（command 保持 undefined）', async () => {
    const { parseArgs } = await import('../src/cli/args.js');
    const a = parseArgs([]);
    expect(a.command).toBeUndefined();
    const h = parseArgs(['help']);
    expect(h.command).toBe('help');
  });
});

describe('probeWebUiState：区分「未起」与「端口被别人占用」', () => {
  test('无人监听 → absent（不是 foreign，也不该等满窗口）', async () => {
    const port = await reservePort();
    expect(await probeWebUiState(port)).toBe('absent');
  });

  test('端口有 HTTP 但没有 WebUI 指纹 → foreign（提示端口冲突，而不是「未启动」）', async () => {
    const port = await reservePort();
    const srv = createHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end('window.__OTHER_APP__ = 1;');
    });
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
    try {
      expect(await probeWebUiState(port)).toBe('foreign');
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  test('带 WebUI 指纹 → ours', async () => {
    const port = await reservePort();
    const srv = createHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end('window.__OCTOPI_GATEWAY__ = { port: 1 };');
    });
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
    try {
      expect(await probeWebUiState(port)).toBe('ours');
      expect(await probeWebUiIdentity(port)).toBe(true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  test('waitMs：进程稍后才起，等待窗口内能等到（Windows 慢启动的回归锚）', async () => {
    const port = await reservePort();
    const srv = createHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end('window.__OCTOPI_GATEWAY__ = null;');
    });
    // 300ms 后才开始监听
    const startLater = new Promise<void>((r) => setTimeout(() => r(), 300));
    const listening = startLater.then(
      () => new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r())),
    );
    try {
      expect(await probeWebUiState(port, { waitMs: 3000 })).toBe('ours');
    } finally {
      await listening.catch(() => {});
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

/**
 * 拿一个空闲端口（先绑再放，避免与真实服务冲突）。
 *
 * @returns 空闲端口号
 */
async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const s = createTcpServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}
