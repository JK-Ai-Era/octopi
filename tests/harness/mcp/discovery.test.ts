/**
 * MCP Discovery 测试 — 目录自动发现
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMcpServersFromDir } from '../../../src/harness/mcp/discovery.js';

describe('loadMcpServersFromDir', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'octopi-mcp-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should load valid MCP server configs', async () => {
    await writeFile(join(tempDir, 'filesystem.json'), JSON.stringify({
      id: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
    }));

    await writeFile(join(tempDir, 'github.json'), JSON.stringify({
      id: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'test' },
    }));

    const configs = await loadMcpServersFromDir(tempDir);

    expect(configs).toHaveLength(2);
    expect(configs[0].id).toBe('filesystem');
    expect(configs[0].transport).toBe('stdio');
    expect(configs[0].command).toBe('npx');
    expect(configs[1].id).toBe('github');
    expect(configs[1].env).toEqual({ GITHUB_TOKEN: 'test' });
  });

  it('should return empty array for non-existent directory', async () => {
    const configs = await loadMcpServersFromDir('/non/existent/path');
    expect(configs).toEqual([]);
  });

  it('should skip non-JSON files', async () => {
    await writeFile(join(tempDir, 'readme.md'), '# MCP Servers');
    await writeFile(join(tempDir, 'valid.json'), JSON.stringify({
      id: 'valid',
      transport: 'stdio',
      command: 'echo',
    }));

    const configs = await loadMcpServersFromDir(tempDir);
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe('valid');
  });

  it('should skip invalid JSON files', async () => {
    await writeFile(join(tempDir, 'broken.json'), '{ invalid json');
    await writeFile(join(tempDir, 'valid.json'), JSON.stringify({
      id: 'valid',
      transport: 'stdio',
      command: 'echo',
    }));

    const configs = await loadMcpServersFromDir(tempDir);
    expect(configs).toHaveLength(1);
  });

  it('should skip configs missing required fields', async () => {
    await writeFile(join(tempDir, 'no-id.json'), JSON.stringify({
      transport: 'stdio',
      command: 'echo',
    }));
    await writeFile(join(tempDir, 'no-transport.json'), JSON.stringify({
      id: 'test',
      command: 'echo',
    }));
    await writeFile(join(tempDir, 'no-command.json'), JSON.stringify({
      id: 'test',
      transport: 'stdio',
    }));

    const configs = await loadMcpServersFromDir(tempDir);
    expect(configs).toHaveLength(0);
  });

  it('should handle HTTP transport configs', async () => {
    await writeFile(join(tempDir, 'remote.json'), JSON.stringify({
      id: 'remote',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    }));

    const configs = await loadMcpServersFromDir(tempDir);
    expect(configs).toHaveLength(1);
    expect(configs[0].transport).toBe('http');
    expect(configs[0].url).toBe('https://example.com/mcp');
    expect(configs[0].headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('should sort configs by filename', async () => {
    await writeFile(join(tempDir, 'z-server.json'), JSON.stringify({
      id: 'z', transport: 'stdio', command: 'echo',
    }));
    await writeFile(join(tempDir, 'a-server.json'), JSON.stringify({
      id: 'a', transport: 'stdio', command: 'echo',
    }));

    const configs = await loadMcpServersFromDir(tempDir);
    expect(configs[0].id).toBe('a');
    expect(configs[1].id).toBe('z');
  });

  it('should return empty for empty directory', async () => {
    const configs = await loadMcpServersFromDir(tempDir);
    expect(configs).toEqual([]);
  });
});
