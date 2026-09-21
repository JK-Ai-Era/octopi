/**
 * loadConfig 对旧字段（supervisor / distributedIntelligence）的告警行为
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

describe('loadConfig supervisor deprecation', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (dirs.length) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function writeConfig(payload: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-cfg-'));
    dirs.push(dir);
    const file = join(dir, 'octopi.json');
    writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
    return file;
  }

  const baseModels = {
    models: {
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          api: 'openai-completions',
          models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
        },
      },
    },
    agents: [{ id: 'a', model: 'openai/gpt-5.5' }],
  };

  it('检测到 supervisor 时打印 warning 且不因未知字段失败', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = writeConfig({
      ...baseModels,
      supervisor: { enabled: true, checkpointInterval: 10 },
    });

    const config = loadConfig(file);
    expect(config.runGuard).toBeUndefined();
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('supervisor') && String(msg).includes('runGuard'))).toBe(true);
  });

  it('检测到 distributedIntelligence 时打印 warning 且不因未知字段失败', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = writeConfig({
      ...baseModels,
      distributedIntelligence: {
        safetyGuard: { enabled: true, model: 'openai/gpt-5-mini' },
      },
    });

    const config = loadConfig(file);
    expect((config as Record<string, unknown>).distributedIntelligence).toBeUndefined();
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('distributedIntelligence'))).toBe(true);
  });

  it('legacy budget 迁移到 budgetPolicy（丢弃 spend hard）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = writeConfig({
      ...baseModels,
      budget: { maxTokens: 1000, maxTimeMs: 60_000, softTokens: 10 },
    });

    const config = loadConfig(file);
    expect(
      warn.mock.calls.some(([msg]) => String(msg).includes('budgetPolicy') || String(msg).includes('budget')),
    ).toBe(true);
    expect((config.budgetPolicy as { maxWallClockMs?: number } | undefined)?.maxWallClockMs).toBe(60_000);
    expect((config as { budget?: unknown }).budget).toBeUndefined();
  });
});
