import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  resolveToolPath,
  resolvePlatformShell,
  resetPlatformShellCache,
  findExecutable,
  commandExists,
  defaultPathEnv,
} from '../../src/harness/plugin-ecosystem/tools/platform.js';
import { createShellTool } from '../../src/harness/plugin-ecosystem/tools/builtin.js';
import { createEnvInfoTool } from '../../src/harness/plugin-ecosystem/tools/env-info.js';
import type { ToolExecutionContext } from '../../src/core/types/tools.js';

function makeContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    sessionId: 'test-session',
    agentId: 'test-agent',
    messages: [],
    ...overrides,
  };
}

describe('resolveToolPath', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `octopi-path-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should keep absolute POSIX paths', () => {
    expect(resolveToolPath('/tmp/foo', tmpDir)).toBe(resolve('/tmp/foo'));
  });

  it('should resolve relative paths against cwd', () => {
    expect(resolveToolPath('sub/file.txt', tmpDir)).toBe(join(tmpDir, 'sub', 'file.txt'));
  });

  it('should keep absolute paths that use the current platform separator', () => {
    const abs = join(tmpDir, 'abs.txt');
    expect(resolveToolPath(abs, '/other')).toBe(abs);
  });
});

describe('resolvePlatformShell', () => {
  afterEach(() => {
    resetPlatformShellCache();
  });

  it('should return a shell with executable and args on current platform', () => {
    resetPlatformShellCache();
    const shell = resolvePlatformShell();
    expect(shell.executable).toBeTruthy();
    expect(shell.args.length).toBeGreaterThan(0);
    expect(['bash', 'powershell', 'cmd']).toContain(shell.kind);
  });

  it('should pick bash family on non-win32', () => {
    if (process.platform === 'win32') return;
    resetPlatformShellCache();
    const shell = resolvePlatformShell();
    expect(shell.kind).toBe('bash');
    expect(shell.args).toContain('-c');
  });

  it('should cache by default and refresh when asked', () => {
    resetPlatformShellCache();
    const a = resolvePlatformShell();
    const b = resolvePlatformShell();
    expect(a).toBe(b);
    const c = resolvePlatformShell({ refresh: true });
    expect(c.kind).toBe(a.kind);
  });
});

describe('findExecutable / commandExists', () => {
  it('should find node on PATH', () => {
    const found = findExecutable('node');
    expect(found).toBeTruthy();
    expect(commandExists('node')).toBe(true);
  });

  it('should return false for missing command', () => {
    expect(commandExists(`octopi-missing-${randomUUID()}`)).toBe(false);
  });

  it('should return null for missing absolute path', () => {
    expect(findExecutable(join(tmpdir(), `nope-${randomUUID()}`))).toBeNull();
  });
});

describe('defaultPathEnv', () => {
  it('should return a non-empty PATH-like string', () => {
    const pathEnv = defaultPathEnv();
    expect(typeof pathEnv).toBe('string');
    expect(pathEnv.length).toBeGreaterThan(0);
  });
});

describe('shell tool platform integration', () => {
  it('should execute a trivial command via the detected platform shell', async () => {
    const tool = createShellTool();
    const result = (await tool.handler(
      { command: process.platform === 'win32' ? 'echo octopi-ok' : 'echo octopi-ok' },
      makeContext(),
    )) as {
      stdout: string;
      exitCode: number | null;
      shell: { kind: string; executable: string };
    };

    expect(result.stdout).toContain('octopi-ok');
    expect(result.exitCode).toBe(0);
    expect(result.shell.kind).toBeTruthy();
    expect(result.shell.executable).toBeTruthy();
  });

  it('should expose detected shell in tool description', () => {
    const tool = createShellTool();
    expect(tool.definition.description).toMatch(/Detected shell:/);
  });
});

describe('env_info platform shell field', () => {
  it('should report platformShell', async () => {
    const tool = createEnvInfoTool();
    const result = (await tool.handler({}, makeContext())) as {
      platformShell: { kind: string; executable: string; label: string };
    };
    expect(result.platformShell.kind).toBeTruthy();
    expect(result.platformShell.executable).toBeTruthy();
    expect(result.platformShell.label).toBeTruthy();
  });
});

describe('file tools accept platform absolute paths', () => {
  it('file_write/file_read work with absolute join paths', async () => {
    const tmpDir = join(tmpdir(), `octopi-abs-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    const filePath = join(tmpDir, 'x.txt');

    const { createFileReadTool, createFileWriteTool } = await import(
      '../../src/harness/plugin-ecosystem/tools/builtin.js'
    );

    await createFileWriteTool().handler(
      { path: filePath, content: 'hello-windows' },
      makeContext({ cwd: tmpDir }),
    );

    const read = (await createFileReadTool().handler(
      { path: filePath },
      makeContext({ cwd: tmpDir }),
    )) as { content: string };

    expect(read.content).toBe('hello-windows');
    await rm(tmpDir, { recursive: true, force: true });
  });
});
