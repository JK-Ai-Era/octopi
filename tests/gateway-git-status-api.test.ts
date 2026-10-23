/**
 * Gateway.getSessionGitStatus — WebUI Git 页签只读状态 API
 * 路径围栏：只接受会话 roots（configured + temporary）之内的绝对路径。
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { GatewayConfig } from '@octopi-agent/gateway/types/gateway-config.js';
import { findExecutable } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/platform.js';

const gitAvailable = findExecutable('git') !== null;

function makeSession(agentId: string, sessionId: string): SessionData {
  return {
    id: sessionId,
    agentId,
    meta: {
      id: sessionId,
      agentId,
      channelId: 'web',
      peerId: 'ui',
      status: 'idle',
      createdAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
    turns: [],
    metadata: {},
    tasks: [],
  };
}

describe('Gateway.getSessionGitStatus', () => {
  let base: string;
  let plainDir: string;
  let outsideDir: string;
  let gateway: Gateway;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'octopi-gitapi-'));
    plainDir = join(base, 'plain');
    outsideDir = `${base}-evil`;
    await mkdir(plainDir);
    await mkdir(outsideDir);
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const store = new InMemorySessionStore();
    const config = {
      agents: [
        {
          id: 'a1',
          model: { provider: 'mock', model: 'mock' },
          workspace: base,
          effectPolicy: { mode: 'workspace' },
        },
      ],
    } as unknown as GatewayConfig;
    gateway = new Gateway(config, store);
    await store.save('s1', makeSession('a1', 's1'));
  });

  it('会话不存在时抛错', async () => {
    await expect(gateway.getSessionGitStatus('missing', base)).rejects.toThrow(/not found/i);
  });

  it('拒绝相对路径与 NUL 注入（path_invalid）', async () => {
    await expect(gateway.getSessionGitStatus('s1', 'relative/path')).rejects.toThrow(
      /path_invalid/,
    );
    await expect(gateway.getSessionGitStatus('s1', '  ')).rejects.toThrow(/path_invalid/);
    await expect(gateway.getSessionGitStatus('s1', '/tmp/a\0b')).rejects.toThrow(/path_invalid/);
  });

  it('拒绝 roots 之外的路径、.. 逃逸与前缀诡计（path_not_allowed）', async () => {
    await expect(gateway.getSessionGitStatus('s1', outsideDir)).rejects.toThrow(
      /path_not_allowed/,
    );
    // '..' 逃逸：resolve 后落到 base 的父目录，必须先归一再围栏
    await expect(
      gateway.getSessionGitStatus('s1', join(base, 'a', '..', '..', 'x')),
    ).rejects.toThrow(/path_not_allowed/);
  });

  it.skipIf(process.platform === 'win32')('符号链接不得逃出 roots（realpath 围栏）', async () => {
    const link = join(base, 'link-to-outside');
    await symlink(outsideDir, link).catch(() => undefined);
    await expect(gateway.getSessionGitStatus('s1', link)).rejects.toThrow(/path_not_allowed/);
  });

  it('不存在 / 非目录路径报 path_not_found', async () => {
    await expect(gateway.getSessionGitStatus('s1', join(base, 'nope'))).rejects.toThrow(
      /path_not_found/,
    );
    const filePath = join(base, 'f.txt');
    await writeFile(filePath, 'x');
    await expect(gateway.getSessionGitStatus('s1', filePath)).rejects.toThrow(/path_not_found/);
  });

  it('roots 内的非仓库目录返回 isRepo=false（path 回显为 canonical 路径）', async () => {
    const snap = await gateway.getSessionGitStatus('s1', plainDir);
    expect(snap.path).toBe(await realpath(plainDir));
    expect(snap.isRepo).toBe(false);
  });

  it.skipIf(!gitAvailable)('workspace root 内的仓库返回结构化状态', async () => {
    const repo = join(base, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await writeFile(join(repo, 'a.txt'), 'hello\n');

    const snap = await gateway.getSessionGitStatus('s1', repo);
    expect(snap.isRepo).toBe(true);
    expect(snap.counts.untracked).toBe(1);
    expect(snap.branch?.head).toBe('main');
  });

  it.skipIf(!gitAvailable)('会话临时 root 解锁新目录', async () => {
    // extra 在 workspace 之外：先拒绝，再经 addSessionEffectRoot 放行
    const extra = `${base}-extra`;
    const extraRepo = join(extra, 'r');
    await mkdir(extraRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: extraRepo, stdio: 'pipe' });

    await expect(gateway.getSessionGitStatus('s1', extraRepo)).rejects.toThrow(/path_not_allowed/);
    await gateway.addSessionEffectRoot('s1', extra);
    const snap = await gateway.getSessionGitStatus('s1', extraRepo);
    expect(snap.isRepo).toBe(true);
    await rm(extra, { recursive: true, force: true });
  });
});

describe('WebApiRouter git-status 路由映射', () => {
  interface CallResult {
    handled: boolean;
    status: number;
    body: { ok: boolean; error?: string; data?: { path?: string } } | null;
    headers: Record<string, string>;
  }

  async function call(router: WebApiRouter, url: string): Promise<CallResult> {
    const req = { url, method: 'GET', headers: { host: 'localhost' } } as unknown as IncomingMessage;
    let status = 0;
    let body: CallResult['body'] = null;
    const headers: Record<string, string> = {};
    const res = {
      writeHead(code: number) {
        status = code;
        return this;
      },
      setHeader(name: string, value: string) {
        headers[name] = value;
        return this;
      },
      end(payload?: string) {
        body = payload ? JSON.parse(payload) : null;
        return this;
      },
    } as unknown as ServerResponse;
    const handled = await router.handle(req, res);
    return { handled, status, body, headers };
  }

  function stubRouter(
    impl: (id: string, path: string, opts?: { maxEntries?: number }) => unknown,
  ): WebApiRouter {
    const stub = {
      getSessionGitStatus: async (id: string, path: string, opts?: { maxEntries?: number }) =>
        impl(id, path, opts),
    };
    return new WebApiRouter({ gateway: stub as unknown as Gateway });
  }

  it('200 正常返回 / 400 缺 path / 400 越界 / 404 会话缺失 / 500 git 失败', async () => {
    const seen: Array<{ id: string; path: string; opts?: { maxEntries?: number } }> = [];
    const router = stubRouter((id, p, opts) => {
      seen.push({ id, path: p, opts });
      if (id === 'missing') throw new Error('Session "missing" not found');
      if (p === '/bad') throw new Error('path_invalid: x');
      if (p === '/outside') throw new Error('path_not_allowed: x');
      if (p === '/gone') throw new Error('path_not_found: x');
      if (p === '/nogit') throw new Error('git_not_found: x');
      if (p === '/boom') throw new Error('git_status_failed: x');
      if (p === '/busy') throw new Error('git_status_busy: x');
      return {
        path: p,
        isRepo: false,
        repoRoot: null,
        branch: null,
        counts: { conflicted: 0, staged: 0, unstaged: 0, untracked: 0 },
        entries: [],
        truncated: false,
        generatedAt: 'now',
      };
    });

    const ok = await call(
      router,
      '/api/v1/sessions/s1/git-status?path=' + encodeURIComponent('/tmp/x'),
    );
    expect(ok.handled).toBe(true);
    expect(ok.status).toBe(200);
    expect(ok.body?.ok).toBe(true);
    expect(ok.body?.data?.path).toBe('/tmp/x');

    const noPath = await call(router, '/api/v1/sessions/s1/git-status');
    expect(noPath.status).toBe(400);
    expect(noPath.body?.error).toBe('path is required');

    expect((await call(router, '/api/v1/sessions/s1/git-status?path=/bad')).status).toBe(400);
    expect((await call(router, '/api/v1/sessions/s1/git-status?path=/outside')).status).toBe(400);
    expect((await call(router, '/api/v1/sessions/s1/git-status?path=/gone')).status).toBe(404);
    expect((await call(router, '/api/v1/sessions/missing/git-status?path=/x')).status).toBe(404);
    expect((await call(router, '/api/v1/sessions/s1/git-status?path=/nogit')).status).toBe(500);
    expect((await call(router, '/api/v1/sessions/s1/git-status?path=/boom')).status).toBe(500);
    const busy = await call(router, '/api/v1/sessions/s1/git-status?path=/busy');
    expect(busy.status).toBe(429);
    expect(busy.headers['Retry-After']).toBe('5');

    // maxEntries 查询参数：透传 + 边界校验
    await call(router, '/api/v1/sessions/s1/git-status?path=/x&maxEntries=5');
    expect(seen.at(-1)?.opts?.maxEntries).toBe(5);
    expect((await call(router, '/api/v1/sessions/s1/git-status?path=/x&maxEntries=abc')).status).toBe(400);
    expect((await call(router, '/api/v1/sessions/s1/git-status?path=/x&maxEntries=0')).status).toBe(400);
  });
});
