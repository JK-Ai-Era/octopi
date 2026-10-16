/**
 * Undo 通道健壮性 + file/git 工具行尾感知（2026-10-17 事故回归）
 *
 * 背景：gateway 测试的 Gateway.stop() 清扫真实 ~/.octopi/sessions/<sid>/undo
 * （已由 tests/setup/isolate-octopi-home.ts 隔离）；清扫者不辨活死会误删
 * 他人活跃 undo；storeBlob 无自愈导致整个 turn 的 file_write/file_edit
 * 集体 ENOENT。行尾侧：file_edit 多行 old_text（\n）在 CRLF 文件上静默
 * 匹配失败、插入 LF 造成混杂行尾；git_commit 无视 HEAD 行尾约定产生整文件 churn。
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  TurnFileUndoLog,
  resolveSessionUndoOnClose,
  isForeignLiveUndoOwner,
  resolveSessionUndoPaths,
} from '@octopi-agent/engine/harness/extension/execution-environment/undo-log.js';
import { createFileEditTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/file-edit.js';
import { createFileWriteTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/builtin.js';
import { createGitTools } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/git-tools.js';
import { findExecutable } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/platform.js';
import { detectEol, toEol, oldTextCandidates } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/eol.js';

const gitAvailable = findExecutable('git') !== null;

function mockCtx(cwd: string) {
  return {
    sessionId: 's',
    agentId: 'a',
    messages: [],
    cwd,
    pathRoots: [cwd],
    pathContainment: 'strict' as const,
    networkPolicy: 'deny' as const,
    shellJournal: 'snapshot' as const,
    effectChannel: 'engine' as const,
    fileEffects: {
      writeFile: async (path: string, data: string | Uint8Array) => {
        await writeFile(path, data);
      },
      appendFile: async (path: string, data: string | Uint8Array) => {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(path, data);
      },
      recordDelete: async () => {},
      recordCreate: async () => {},
      recordRename: async () => {},
      recordOverwrite: async () => {},
      noteNotReversed: async () => {},
    },
    memoryEffects: {
      recordInsert: async () => {},
      recordUpdate: async () => {},
      recordDelete: async () => {},
    },
  };
}

describe('TurnFileUndoLog 健壮性', () => {
  it('storeBlob 自愈：blobs 目录被外部清扫后文件写入仍成功', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'undo-selfheal-'));
    const biz = join(sessionsDir, 'biz.txt');
    try {
      const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId: 's1' });
      // 模拟外部清扫者删掉 blobs 目录（事故场景）
      await rm(join(sessionsDir, 's1', 'undo', 'blobs'), { recursive: true, force: true });

      await expect(log.writeFile(biz, 'hello')).resolves.toBeUndefined();
      expect(await readFile(biz, 'utf8')).toBe('hello');
      const blobs = await readdir(join(sessionsDir, 's1', 'undo', 'blobs'));
      expect(blobs.length).toBeGreaterThan(0);
      await log.commit();
    } finally {
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });

  it('begin 写 owner.json；skipLiveForeign 跳过他人活跃 undo、清扫死进程残留', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'undo-owner-'));
    try {
      const log = await TurnFileUndoLog.begin({ sessionsDir, sessionId: 's2' });
      const paths = resolveSessionUndoPaths(sessionsDir, 's2');
      const owner = JSON.parse(await readFile(join(paths.root, 'owner.json'), 'utf8')) as {
        pid: number;
      };
      expect(owner.pid).toBe(process.pid);

      // 伪装他人活跃 owner：ppid 必存活且非本进程
      await writeFile(join(paths.root, 'owner.json'), JSON.stringify({ pid: process.ppid }));
      expect(await isForeignLiveUndoOwner(paths)).toBe(true);
      const skipped = await resolveSessionUndoOnClose({
        sessionsDir,
        sessionId: 's2',
        onClose: 'commit',
        skipLiveForeign: true,
      });
      expect(skipped).toBe('none');

      // 死进程 owner：按崩溃残留清扫
      const dead = spawnSync(process.execPath, ['-e', '']);
      await writeFile(join(paths.root, 'owner.json'), JSON.stringify({ pid: dead.pid }));
      const cleaned = await resolveSessionUndoOnClose({
        sessionsDir,
        sessionId: 's2',
        onClose: 'commit',
        skipLiveForeign: true,
      });
      expect(cleaned).toBe('committed');
      void log;
    } finally {
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });
});

describe('eol 工具', () => {
  it('detectEol / toEol / oldTextCandidates 基本行为', () => {
    expect(detectEol('a\r\nb\r\n')).toBe('\r\n');
    expect(detectEol('a\nb\n')).toBe('\n');
    expect(detectEol('')).toBe('\n');
    expect(toEol('a\nb\r\nc', '\r\n')).toBe('a\r\nb\r\nc'.replace(/\r\n|\n/g, '\r\n'));
    const candidates = oldTextCandidates('a\nb');
    expect(candidates).toContain('a\r\nb');
    expect(candidates[0]).toBe('a\nb');
  });
});

describe('file 工具行尾感知', () => {
  it('file_edit 多行 old_text（\n）匹配 CRLF 文件，插入行尾跟随文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eol-edit-'));
    try {
      const p = join(dir, 'crlf.txt');
      await writeFile(p, 'line1\r\nline2\r\nline3\r\n');
      const tool = createFileEditTool();
      await tool.handler(
        { path: p, old_text: 'line2\nline3', new_text: 'line2\nlineX\nline3' },
        mockCtx(dir) as never,
      );
      expect(await readFile(p, 'utf8')).toBe('line1\r\nline2\r\nlineX\r\nline3\r\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('file_write 覆写 CRLF 文件保留 CRLF；新建文件保持内容原样', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eol-write-'));
    try {
      const tool = createFileWriteTool();
      const p = join(dir, 'w.txt');
      await writeFile(p, 'a\r\nb\r\n');
      await tool.handler({ path: p, content: 'x\ny\n' }, mockCtx(dir) as never);
      expect(await readFile(p, 'utf8')).toBe('x\r\ny\r\n');

      const fresh = join(dir, 'fresh.txt');
      await tool.handler({ path: fresh, content: 'x\ny\n' }, mockCtx(dir) as never);
      expect(await readFile(fresh, 'utf8')).toBe('x\ny\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!gitAvailable)('git_commit EOL 归一', () => {
  it('LF HEAD + CRLF worktree → 提交回 LF 约定（消除整文件 churn）', async () => {
    const { execFileSync } = await import('node:child_process');
    const repo = await mkdtemp(join(tmpdir(), 'git-eol-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
      await mkdir(repo, { recursive: true });
      await writeFile(join(repo, 'a.txt'), 'hello\n');

      const tools = createGitTools();
      const call = (name: string, args: Record<string, unknown>) => {
        const tool = tools.find((t) => t.definition.name === name)!;
        return tool.handler(args, mockCtx(repo) as never);
      };

      await call('git_commit', { cwd: repo, message: 'init', paths: ['a.txt'] });

      // 模拟事故：worktree 被 CRLF 化 + 实改一行
      await writeFile(join(repo, 'a.txt'), 'hello\r\nworld\r\n');
      const result = (await call('git_commit', {
        cwd: repo,
        message: 'change',
        paths: ['a.txt'],
      })) as { exitCode: number; eolNormalized: string[] };
      expect(result.exitCode).toBe(0);
      expect(result.eolNormalized).toContain('a.txt');

      const blob = execFileSync('git', ['show', 'HEAD:a.txt'], { cwd: repo, encoding: 'utf8' });
      expect(blob).toBe('hello\nworld\n');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('eol: keep 保持字节原样', async () => {
    const { execFileSync } = await import('node:child_process');
    const repo = await mkdtemp(join(tmpdir(), 'git-eol-keep-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
      await writeFile(join(repo, 'b.txt'), 'hello\n');

      const tools = createGitTools();
      const call = (name: string, args: Record<string, unknown>) => {
        const tool = tools.find((t) => t.definition.name === name)!;
        return tool.handler(args, mockCtx(repo) as never);
      };

      await call('git_commit', { cwd: repo, message: 'init', paths: ['b.txt'] });
      await writeFile(join(repo, 'b.txt'), 'hello\r\nworld\r\n');
      const result = (await call('git_commit', {
        cwd: repo,
        message: 'change',
        paths: ['b.txt'],
        eol: 'keep',
      })) as { exitCode: number; eolNormalized: string[] };
      expect(result.exitCode).toBe(0);
      expect(result.eolNormalized).toEqual([]);

      const blob = execFileSync('git', ['show', 'HEAD:b.txt'], { cwd: repo, encoding: 'utf8' });
      expect(blob).toBe('hello\r\nworld\r\n');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
