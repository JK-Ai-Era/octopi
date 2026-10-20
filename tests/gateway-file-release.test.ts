/**
 * FileReleaseService — 签发 / 内容读取 / 审计
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileReleaseService,
  detectMime,
  isTextMime,
  parseRangeHeader,
} from '@octopi-agent/gateway/gateway/file-release.js';

describe('detectMime / isTextMime / parseRangeHeader', () => {
  it('maps common extensions', () => {
    expect(detectMime('a.md')).toBe('text/markdown');
    expect(detectMime('a.png')).toBe('image/png');
    expect(detectMime('a.mp4')).toBe('video/mp4');
    expect(detectMime('a.bin')).toBe('application/octet-stream');
    expect(isTextMime('text/markdown')).toBe(true);
    expect(isTextMime('image/png')).toBe(false);
  });

  it('parses range headers', () => {
    expect(parseRangeHeader(undefined, 100)).toBeNull();
    expect(parseRangeHeader('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRangeHeader('bytes=10-', 100)).toEqual({ start: 10, end: 99 });
    expect(parseRangeHeader('bytes=-20', 100)).toEqual({ start: 80, end: 99 });
    expect(parseRangeHeader('bytes=200-300', 100)).toBe('unsatisfiable');
  });
});

describe('FileReleaseService', () => {
  let workDir: string;
  let auditDir: string;
  let workspace: string;
  let svc: FileReleaseService;
  let indexStore: Record<string, unknown[]>;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'octopi-file-rel-'));
    auditDir = join(workDir, 'audit');
    workspace = join(workDir, 'ws');
    await mkdir(workspace, { recursive: true });
    indexStore = {};
    svc = new FileReleaseService({
      auditDir,
      persistIndex: async (sessionId, entries) => {
        indexStore[sessionId] = entries;
      },
      loadIndex: async (sessionId) => (indexStore[sessionId] as never) ?? [],
    });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('releases a workspace file and serves bytes', async () => {
    const file = join(workspace, 'report.md');
    await writeFile(file, '# Hello\n\nWorld', 'utf8');

    const { fileRef, record } = await svc.release({
      sessionId: 's1',
      agentId: 'a1',
      toolName: 'send_file',
      path: 'report.md',
      allowedRoots: [workspace],
      resolveBases: [workspace],
    });
    expect(fileRef.mime).toBe('text/markdown');
    expect(fileRef.sizeBytes).toBeGreaterThan(0);
    // absPath 契约 = realpath 后的绝对路径（防 symlink 逃逸，见 FileReleaseRecord）
    expect(record.absPath).toBe(await realpath(file));

    const content = await svc.readContent('s1', fileRef.fileId);
    expect(content.ok).toBe(true);
    if (content.ok) {
      const { handle, start, end } = content;
      const buf = Buffer.alloc(Math.max(0, end - start + 1));
      await handle.read(buf, 0, buf.length, start);
      await handle.close();
      expect(buf.toString('utf8')).toContain('Hello');
    }
  });

  it('denies path outside allowed roots and audits rejected', async () => {
    await expect(
      svc.release({
        sessionId: 's1',
        agentId: 'a1',
        toolName: 'send_file',
        path: join(workDir, 'outside.txt'),
        allowedRoots: [workspace],
        resolveBases: [workspace],
      }),
    ).rejects.toThrow(/PATH_FORBIDDEN|invalid_arguments/);

    const day = new Date().toISOString().slice(0, 10);
    const audit = await readFile(join(auditDir, 'files', `${day}.jsonl`), 'utf8');
    expect(audit).toContain('file.rejected');
    expect(audit).toContain('PATH_FORBIDDEN');
  });

  it('blocks sensitive filenames', async () => {
    const file = join(workspace, '.env');
    await writeFile(file, 'SECRET=1', 'utf8');
    await expect(
      svc.release({
        sessionId: 's1',
        agentId: 'a1',
        toolName: 'send_file',
        path: '.env',
        allowedRoots: [workspace],
        resolveBases: [workspace],
      }),
    ).rejects.toThrow(/SENSITIVE/);
  });

  it('denies fetch for unknown fileId and wrong session', async () => {
    const file = join(workspace, 'ok.txt');
    await writeFile(file, 'hi', 'utf8');
    const { fileRef } = await svc.release({
      sessionId: 's1',
      agentId: 'a1',
      toolName: 'send_file',
      path: 'ok.txt',
      allowedRoots: [workspace],
      resolveBases: [workspace],
    });

    expect(await svc.readContent('s1', 'f_nope')).toEqual({ ok: false, reason: 'not_found' });
    expect(await svc.readContent('s2', fileRef.fileId)).toEqual({ ok: false, reason: 'not_found' });

    const day = new Date().toISOString().slice(0, 10);
    const audit = await readFile(join(auditDir, 'files', `${day}.jsonl`), 'utf8');
    expect(audit).toContain('file.denied');
  });

  it('supports range reads and audits fetched', async () => {
    const file = join(workspace, 'range.txt');
    await writeFile(file, '0123456789', 'utf8');
    const { fileRef } = await svc.release({
      sessionId: 's1',
      agentId: 'a1',
      toolName: 'send_file',
      path: 'range.txt',
      allowedRoots: [workspace],
      resolveBases: [workspace],
    });
    const part = await svc.readContent('s1', fileRef.fileId, { rangeHeader: 'bytes=2-5' });
    expect(part.ok).toBe(true);
    if (part.ok) {
      const buf = Buffer.alloc(part.end - part.start + 1);
      await part.handle.read(buf, 0, buf.length, part.start);
      await part.handle.close();
      expect(buf.toString('utf8')).toBe('2345');
    }
    const day = new Date().toISOString().slice(0, 10);
    const audit = await readFile(join(auditDir, 'files', `${day}.jsonl`), 'utf8');
    expect(audit).toContain('file.fetched');
  });

  it('honors configurable maxBytes (default 2GB class, custom small)', async () => {
    const file = join(workspace, 'big.txt');
    await writeFile(file, '0123456789', 'utf8');
    const limited = new FileReleaseService({
      auditDir,
      maxBytes: 5,
      persistIndex: async () => {},
      loadIndex: async () => [],
    });
    await expect(
      limited.release({
        sessionId: 's1',
        agentId: 'a1',
        toolName: 'send_file',
        path: 'big.txt',
        allowedRoots: [workspace],
        resolveBases: [workspace],
      }),
    ).rejects.toThrow(/file too large/);
  });

  it('honors maxReleasesPerSession; 0 means unlimited', async () => {
    const a = join(workspace, 'a.txt');
    const b = join(workspace, 'b.txt');
    await writeFile(a, 'a', 'utf8');
    await writeFile(b, 'b', 'utf8');

    const unlimited = new FileReleaseService({
      auditDir,
      maxReleasesPerSession: 0,
      persistIndex: async () => {},
      loadIndex: async () => [],
    });
    await unlimited.release({
      sessionId: 's1',
      agentId: 'a1',
      toolName: 'send_file',
      path: 'a.txt',
      allowedRoots: [workspace],
      resolveBases: [workspace],
    });
    await unlimited.release({
      sessionId: 's1',
      agentId: 'a1',
      toolName: 'send_file',
      path: 'b.txt',
      allowedRoots: [workspace],
      resolveBases: [workspace],
    });
    expect(await unlimited.listSessionReleases('s1')).toHaveLength(2);

    const capped = new FileReleaseService({
      auditDir: join(workDir, 'audit2'),
      maxReleasesPerSession: 1,
      persistIndex: async () => {},
      loadIndex: async () => [],
    });
    await capped.release({
      sessionId: 's1',
      agentId: 'a1',
      toolName: 'send_file',
      path: 'a.txt',
      allowedRoots: [workspace],
      resolveBases: [workspace],
    });
    await expect(
      capped.release({
        sessionId: 's1',
        agentId: 'a1',
        toolName: 'send_file',
        path: 'b.txt',
        allowedRoots: [workspace],
        resolveBases: [workspace],
      }),
    ).rejects.toThrow(/quota_exceeded/);
  });

  it('blocks symlink escape outside allowed roots (realpath)', async () => {
    const outside = join(workDir, 'secret.txt');
    await writeFile(outside, 'TOP_SECRET', 'utf8');
    const link = join(workspace, 'notes.md');
    try {
      const { symlink } = await import('node:fs/promises');
      await symlink(outside, link);
    } catch {
      // Windows without developer mode may fail symlink; skip
      return;
    }
    await expect(
      svc.release({
        sessionId: 's1',
        agentId: 'a1',
        toolName: 'send_file',
        path: 'notes.md',
        allowedRoots: [workspace],
        resolveBases: [workspace],
      }),
    ).rejects.toThrow(/PATH_FORBIDDEN|invalid_arguments/);
  });

  it('blocks symlink to sensitive name even if link name looks safe', async () => {
    const secret = join(workspace, '.env');
    await writeFile(secret, 'SECRET=1', 'utf8');
    const link = join(workspace, 'harmless.txt');
    try {
      const { symlink } = await import('node:fs/promises');
      await symlink(secret, link);
    } catch {
      return;
    }
    await expect(
      svc.release({
        sessionId: 's1',
        agentId: 'a1',
        toolName: 'send_file',
        path: 'harmless.txt',
        allowedRoots: [workspace],
        resolveBases: [workspace],
      }),
    ).rejects.toThrow(/SENSITIVE|PATH_FORBIDDEN|invalid_arguments/);
  });

  it('hydrateSession is race-safe for concurrent first access', async () => {
    const file = join(workspace, 'h.txt');
    await writeFile(file, 'hi', 'utf8');
    const released = await svc.release({
      sessionId: 'sHydrate',
      agentId: 'a1',
      toolName: 'send_file',
      path: 'h.txt',
      allowedRoots: [workspace],
      resolveBases: [workspace],
    });
    const store: Record<string, unknown[]> = {};
    const svc2 = new FileReleaseService({
      auditDir,
      persistIndex: async (sid, entries) => {
        store[sid] = entries;
      },
      loadIndex: async (sid) => (store[sid] as never) ?? (indexStore[sid] as never) ?? [],
    });
    // seed index
    store['s2'] = [
      {
        fileId: released.fileRef.fileId,
        name: released.fileRef.name,
        mime: released.fileRef.mime,
        sizeBytes: released.fileRef.sizeBytes,
        absPath: join(workspace, 'h.txt'),
        sourcePathDisplay: 'h.txt',
        sourceKind: 'workspace',
        toolName: 'send_file',
        createdAt: Date.now(),
      },
    ];
    const [a, b] = await Promise.all([
      svc2.readContent('s2', released.fileRef.fileId),
      svc2.readContent('s2', released.fileRef.fileId),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok) await a.handle.close();
    if (b.ok) await b.handle.close();
    const list = await svc2.listSessionReleases('s2');
    expect(list.some((r) => r.fileId === released.fileRef.fileId)).toBe(true);
  });

  it('simulates restart: metadata fileReleases restores list + fetch', async () => {
    const file = join(workspace, 'boot.md');
    await writeFile(file, '# boot', 'utf8');
    // 模拟 session.metadata
    const metadata: Record<string, Record<string, unknown>> = {};
    const persistIndex = async (sessionId: string, entries: unknown) => {
      const meta = metadata[sessionId] ?? (metadata[sessionId] = {});
      meta.fileReleases = entries;
    };
    const loadIndex = async (sessionId: string) =>
      (metadata[sessionId]?.fileReleases as never) ?? [];
    const s1 = new FileReleaseService({
      auditDir,
      persistIndex,
      loadIndex,
    });
    const { fileRef } = await s1.release({
      sessionId: 's-boot',
      agentId: 'a1',
      toolName: 'send_file',
      path: 'boot.md',
      allowedRoots: [workspace],
      resolveBases: [workspace],
    });
    // 重启：新实例，空内存
    const s2 = new FileReleaseService({
      auditDir,
      persistIndex,
      loadIndex,
    });
    const list = await s2.listSessionReleases('s-boot');
    expect(list.map((r) => r.fileId)).toContain(fileRef.fileId);
    const content = await s2.readContent('s-boot', fileRef.fileId);
    expect(content.ok).toBe(true);
    if (content.ok) {
      const buf = Buffer.alloc(content.end - content.start + 1);
      await content.handle.read(buf, 0, buf.length, content.start);
      await content.handle.close();
      expect(buf.toString('utf8')).toContain('boot');
    }
  });

  it('parseRangeHeader handles suffix and unsatisfiable', () => {
    expect(parseRangeHeader('bytes=-20', 100)).toEqual({ start: 80, end: 99 });
    expect(parseRangeHeader('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRangeHeader('bytes=abc-def', 100)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=-0', 100)).toBe('unsatisfiable');
  });

});
