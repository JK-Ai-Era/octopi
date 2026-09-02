/**
 * CLI 集成测试
 *
 * 测试 CLI 命令的基本行为，不依赖外部服务。
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, createStoreFromConfig } from '../src/config.js';
import { validateConfig } from '../src/config-schema.js';
import { initOctopi, isInitialized } from '../src/init.js';

// ── 临时目录管理 ──

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `octopi-cli-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ── 辅助函数 ──

function writeConfig(config: any, dir?: string): string {
  const targetDir = dir ?? tempDir;
  const configPath = join(targetDir, 'octopi.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

const SAMPLE_MODELS = {
  providers: {
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      api: 'openai-completions',
      models: [{ id: 'gpt-4', name: 'gpt-4', contextWindow: 128000, maxTokens: 4096 }],
    },
  },
};

// ── 测试 ──

describe('Config Loading', () => {
  test('loads valid config', () => {
    const path = writeConfig({
      agents: [{ id: 'test', model: 'openai/gpt-4' }],
      models: SAMPLE_MODELS,
    });
    const config = loadConfig(path);
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].id).toBe('test');
  });

  test('rejects config without agents', () => {
    const path = writeConfig({ providers: [] });
    expect(() => loadConfig(path)).toThrow();
  });

  test('rejects agent without id', () => {
    const path = writeConfig({
      agents: [{ model: { provider: 'openai', model: 'gpt-4' } }],
    });
    expect(() => loadConfig(path)).toThrow();
  });

  test('rejects agent without model provider', () => {
    const path = writeConfig({
      agents: [{ id: 'test', model: { model: 'gpt-4' } }],
    });
    expect(() => loadConfig(path)).toThrow();
  });
});

describe('Config Schema Validation', () => {
  test('validates correct config', () => {
    const result = validateConfig({
      agents: [{ id: 'test', model: 'openai/gpt-4' }],
      models: SAMPLE_MODELS,
    });
    expect(result.success).toBe(true);
  });

  test('returns structured errors', () => {
    const result = validateConfig({
      agents: [{ model: { provider: 'openai', model: 'gpt-4' } }],
    });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(result.errors![0].path).toBeDefined();
    expect(result.errors![0].message).toBeDefined();
  });

  test('validates provider type', () => {
    const result = validateConfig({
      agents: [{ id: 'test', model: { provider: 'invalid', model: 'gpt-4' } }],
      providers: [{ type: 'invalid', name: 'test' }],
    });
    // Agent references non-existent provider type - schema validates provider type
    expect(result.success).toBe(false);
  });

  test('validates store type', () => {
    const result = validateConfig({
      agents: [{ id: 'test', model: { provider: 'openai', model: 'gpt-4' } }],
      store: { type: 'invalid' },
    });
    expect(result.success).toBe(false);
  });

  test('accepts sqlite store type', () => {
    const result = validateConfig({
      agents: [{ id: 'test', model: 'openai/gpt-4' }],
      models: SAMPLE_MODELS,
      store: { type: 'sqlite' },
    });
    expect(result.success).toBe(true);
  });
});

describe('Store Factory', () => {
  test('creates memory store', async () => {
    const store = await createStoreFromConfig({ type: 'memory' });
    expect(store).toBeDefined();
    await store.save('a', 'test', { id: 'test', agentId: 'a', meta: {} as any, messages: [], turns: [], metadata: {} });
    const loaded = await store.load('a', 'test');
    expect(loaded).toBeDefined();
  });

  test('creates jsonl store', async () => {
    const dataDir = join(tempDir, 'sessions');
    mkdirSync(dataDir, { recursive: true });
    const store = await createStoreFromConfig({ type: 'jsonl', dataDir });
    expect(store).toBeDefined();
  });

  test('rejects jsonl without dataDir', async () => {
    await expect(createStoreFromConfig({ type: 'jsonl' })).rejects.toThrow('requires dataDir');
  });
});

describe('Init Command', () => {
  test('detects uninitialized directory', () => {
    expect(isInitialized(tempDir)).toBe(false);
  });
});
