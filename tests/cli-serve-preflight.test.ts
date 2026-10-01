/**
 * serve start preflight：端口占用者三态识别
 *
 * 场景矩阵：
 * - free        端口空闲 → 可以启动
 * - own-gateway health 形状匹配 / pid 文件命中 → 幂等，不是错误
 * - foreign     其他进程占用 → 错误，需给出身份与出路
 * - unknown     有 HTTP 响应但拿不到持有者 → 警告后继续
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { identifyPortOccupant } from '../src/cli/daemon.js';
import {
  spawnDetached,
  killProcess,
  isProcessAlive,
  findPidOnPort,
  delay,
} from '../src/cli/process-utils.js';

let tempHome: string;
let prevHome: string | undefined;
let servers: Server[] = [];
let tcpServers: TcpServer[] = [];
let childPids: number[] = [];

beforeEach(() => {
  tempHome = join(tmpdir(), `octopi-preflight-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempHome, { recursive: true });
  prevHome = process.env.OCTOPI_HOME;
  process.env.OCTOPI_HOME = tempHome;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OCTOPI_HOME;
  else process.env.OCTOPI_HOME = prevHome;
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  for (const s of tcpServers) await new Promise<void>((r) => s.close(() => r()));
  for (const pid of childPids) {
    if (isProcessAlive(pid)) await killProcess(pid, { timeoutMs: 3000 });
  }
  servers = [];
  tcpServers = [];
  childPids = [];
  if (existsSync(tempHome)) rmSync(tempHome, { recursive: true, force: true });
});

/** 绑定临时端口后立即释放，返回一个大概率空闲的端口 */
async function getFreePort(): Promise<number> {
  const srv = createTcpServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  if (typeof addr === 'string' || addr === null) throw new Error('expected port');
  const port = addr.port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** 轮询直到条件成立（子进程服务器就绪 / netstat 可见） */
async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await delay(200);
  }
  return false;
}

function writePidFile(data: { pid: number; port: number; startedAt?: string; config?: string }): void {
  writeFileSync(
    join(tempHome, 'gateway.pid'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        config: join(tempHome, 'octopi.json'),
        ...data,
      },
      null,
      2,
    ),
  );
}

/** 拉起一个监听 127.0.0.1:port 的子进程 HTTP 服务 */
async function spawnHttpHolder(
  port: number,
  respond: 'octopi' | 'other',
): Promise<number> {
  const body =
    respond === 'octopi'
      ? JSON.stringify({ status: 'ok', adapter: 'http', websocket: true })
      : JSON.stringify({ hello: 'not-octopi' });
  const script = `
    const http = require('http');
    http.createServer((q, s) => {
      s.setHeader('content-type', 'application/json');
      if (q.url === '/health') { s.end(${JSON.stringify(body)}); return; }
      s.statusCode = 404; s.end('{}');
    }).listen(${port}, '127.0.0.1');
  `;
  const pid = spawnDetached(process.execPath, ['-e', script]);
  if (!pid) throw new Error('spawnDetached failed');
  childPids.push(pid);
  const ready = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      return res.ok;
    } catch {
      return false;
    }
  });
  if (!ready) throw new Error(`holder did not become ready on ${port}`);
  return pid;
}

describe('identifyPortOccupant', () => {
  test('free: 端口空闲', async () => {
    const port = await getFreePort();
    const occ = await identifyPortOccupant(port);
    expect(occ.state).toBe('free');
    expect(occ.pid).toBeNull();
  });

  test('own-gateway: health 形状匹配（即使监听者是当前进程）', async () => {
    const port = await getFreePort();
    const srv = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', adapter: 'http' }));
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', r));

    const occ = await identifyPortOccupant(port);
    expect(occ.state).toBe('own-gateway');
    expect(occ.healthy).toBe(true);
  });

  test('own-gateway: 监听 pid 与 pid 文件一致（gateway 启动中、health 未就绪）', async () => {
    const port = await getFreePort();
    const childPid = await spawnHttpHolder(port, 'other');
    writePidFile({ pid: childPid, port });

    const occ = await identifyPortOccupant(port);
    expect(occ.state).toBe('own-gateway');
    expect(occ.healthy).toBe(false);
    expect(occ.pid).toBe(childPid);
    expect(occ.startedAt).toBeTruthy();
  }, 30_000);

  test('own-gateway: 无监听者但 pid 文件进程存活且端口一致（启动窗口期防双开）', async () => {
    const port = await getFreePort();
    writePidFile({ pid: process.pid, port });

    const occ = await identifyPortOccupant(port);
    expect(occ.state).toBe('own-gateway');
    expect(occ.healthy).toBe(false);
    expect(occ.pid).toBe(process.pid);
  });

  test('foreign: 其他进程占用且 pid 文件不匹配 → 给出 pid 与进程名', async () => {
    const port = await getFreePort();
    const childPid = await spawnHttpHolder(port, 'other');
    // pid 文件指向别的进程（陈旧），不能冒充自己的 gateway
    writePidFile({ pid: process.pid, port });

    const occ = await identifyPortOccupant(port);
    expect(occ.state).toBe('foreign');
    expect(occ.pid).toBe(childPid);
    expect(occ.processName).toBeTruthy();
  }, 30_000);

  test('unknown: 有 HTTP 响应但持有者不可归属（pid 探测被排除时）', async () => {
    const port = await getFreePort();
    const srv = createServer((_req, res) => {
      res.statusCode = 404;
      res.end('{}');
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', r));

    // 自身监听会被 findPidOnPort 排除 → 模拟"HTTP 活着但拿不到 pid"
    const occ = await identifyPortOccupant(port);
    expect(occ.state).toBe('unknown');
    expect(occ.pid).toBeNull();
  });

  test('foreign: 纯 TCP 占用（非 HTTP）不会被误判为自己的 gateway', async () => {
    const port = await getFreePort();
    const childPid = spawnDetached(process.execPath, [
      '-e',
      `require('net').createServer(() => {}).listen(${port}, '127.0.0.1')`,
    ]);
    if (!childPid) throw new Error('spawnDetached failed');
    childPids.push(childPid);
    // 等子进程真正开始监听（netstat 可见）
    const ready = await waitFor(() => findPidOnPort(port) === childPid);
    expect(ready).toBe(true);

    const occ = await identifyPortOccupant(port);
    // 持有者不是 octopi health 形状、pid 文件不匹配 → foreign
    expect(occ.state).toBe('foreign');
    expect(occ.pid).toBe(childPid);
  }, 30_000);
});
