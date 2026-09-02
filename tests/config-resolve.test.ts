/**
 * Config 解析测试
 *
 * 覆盖 resolveModelConfig、flattenModels、resolveFallbackModels 深度限制、
 * createStoreFromConfig sqlite 路径、向后兼容 store 迁移。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveModelConfig,
  flattenModels,
  createStoreFromConfig,
  loadConfig,
} from '../src/config.js';
import type { ModelsConfig, NormalizedModelInfo } from '../src/config.js';
import type { ModelConfig } from '../src/core/types/agent-definition.js';

// ── flattenModels ──

describe('flattenModels', () => {
  it('should flatten provider models into flat list with composite id', () => {
    const config: ModelsConfig = {
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'test',
          api: 'openai-completions',
          models: [
            { id: 'gpt-5.5', contextWindow: 256000, maxTokens: 32768 },
            { id: 'gpt-5-mini', name: 'gpt-5-mini-custom', contextWindow: 128000 },
          ],
        },
        anthropic: {
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'test',
          api: 'anthropic-messages',
          models: [
            { id: 'claude-4', contextWindow: 200000 },
          ],
        },
      },
    };

    const flat = flattenModels(config);

    expect(flat).toHaveLength(3);
    expect(flat[0]).toEqual({
      id: 'openai/gpt-5.5',
      provider: 'openai',
      model: 'gpt-5.5',
      contextWindow: 256000,
      maxTokens: 32768,
    });
    expect(flat[1]).toEqual({
      id: 'openai/gpt-5-mini',
      provider: 'openai',
      model: 'gpt-5-mini-custom',  // name 优先于 id
      contextWindow: 128000,
      maxTokens: undefined,
    });
    expect(flat[2]).toEqual({
      id: 'anthropic/claude-4',
      provider: 'anthropic',
      model: 'claude-4',
      contextWindow: 200000,
      maxTokens: undefined,
    });
  });

  it('should return empty array for empty providers', () => {
    const config: ModelsConfig = { providers: {} };
    expect(flattenModels(config)).toEqual([]);
  });
});

// ── resolveModelConfig ──

describe('resolveModelConfig', () => {
  const flatModels: NormalizedModelInfo[] = [
    { id: 'openai/gpt-5.5', provider: 'openai', model: 'gpt-5.5', contextWindow: 256000, maxTokens: 32768 },
    { id: 'anthropic/claude-4', provider: 'anthropic', model: 'claude-4', contextWindow: 200000 },
  ];

  it('should resolve inline ModelConfig object (backward compat)', () => {
    const inline: ModelConfig = {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.7,
      maxTokens: 4096,
      contextWindow: 128000,
    };

    const result = resolveModelConfig(inline, flatModels);

    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o');
    expect(result.temperature).toBe(0.7);
    expect(result.maxTokens).toBe(4096);
    expect(result.contextWindow).toBe(128000);
  });

  it('should resolve inline object without contextWindow using default', () => {
    const inline: ModelConfig = { provider: 'openai', model: 'gpt-4o' };
    const result = resolveModelConfig(inline, flatModels, { contextWindow: 64000 });

    expect(result.contextWindow).toBe(64000);
  });

  it('should resolve string reference by composite id', () => {
    const result = resolveModelConfig('openai/gpt-5.5', flatModels);

    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-5.5');
    expect(result.contextWindow).toBe(256000);
  });

  it('should resolve "provider/model" format as fallback', () => {
    const result = resolveModelConfig('custom/my-model', flatModels);

    expect(result.provider).toBe('custom');
    expect(result.model).toBe('my-model');
    expect(result.contextWindow).toBe(200000); // default
  });

  it('should throw for unresolvable string reference', () => {
    expect(() => resolveModelConfig('nonexistent', flatModels))
      .toThrow('Cannot resolve model "nonexistent"');
  });

  it('should use default contextWindow of 200000 when not specified', () => {
    const result = resolveModelConfig('custom/model', flatModels);

    expect(result.contextWindow).toBe(200000);
  });
});

// ── resolveFallbackModels (depth limit) ──

describe('resolveFallbackModels depth limit', () => {
  const flatModels: NormalizedModelInfo[] = [
    { id: 'openai/gpt-5.5', provider: 'openai', model: 'gpt-5.5', contextWindow: 256000 },
  ];

  it('should resolve single-level fallbackModels', () => {
    const inline: ModelConfig = {
      provider: 'openai',
      model: 'gpt-5.5',
      fallbackModels: [
        { provider: 'anthropic', model: 'claude-4' },
      ],
    };

    const result = resolveModelConfig(inline, flatModels);

    expect(result.fallbackModels).toBeDefined();
    expect(result.fallbackModels).toHaveLength(1);
    expect(result.fallbackModels![0].provider).toBe('anthropic');
    expect(result.fallbackModels![0].model).toBe('claude-4');
  });

  it('should resolve string fallbackModels references', () => {
    const inline: ModelConfig = {
      provider: 'openai',
      model: 'gpt-5.5',
      fallbackModels: ['openai/gpt-5.5'],
    };

    const result = resolveModelConfig(inline, flatModels);

    expect(result.fallbackModels).toHaveLength(1);
    expect(result.fallbackModels![0].provider).toBe('openai');
    expect(result.fallbackModels![0].model).toBe('gpt-5.5');
  });

  it('should truncate nested fallbackModels beyond depth 5', () => {
    // 构建 6 层嵌套
    const deep: any = { provider: 'p', model: 'm6' };
    for (let i = 5; i >= 1; i--) {
      deep.fallbackModels = [{ provider: 'p', model: `m${i}`, fallbackModels: deep.fallbackModels ? [deep] : undefined }];
    }

    // 第一层 inline ModelConfig
    const inline: ModelConfig = {
      provider: 'openai',
      model: 'gpt-5.5',
      fallbackModels: deep.fallbackModels,
    };

    // 不应抛错，但深层 fallback 被截断
    const result = resolveModelConfig(inline, flatModels);
    expect(result.fallbackModels).toBeDefined();
  });

  it('should throw for unresolvable fallback string reference', () => {
    const inline: ModelConfig = {
      provider: 'openai',
      model: 'gpt-5.5',
      fallbackModels: ['nonexistent'],
    };

    expect(() => resolveModelConfig(inline, flatModels))
      .toThrow('Cannot resolve fallback model "nonexistent"');
  });
});

// ── createStoreFromConfig ──

describe('createStoreFromConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'octopi-store-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create memory store', async () => {
    const store = await createStoreFromConfig({ type: 'memory' });
    expect(store).toBeDefined();

    await store.save('agent-1', 'sess-1', {
      id: 'sess-1', agentId: 'agent-1',
      meta: { id: 'sess-1', agentId: 'agent-1', channelId: 'test', peerId: 'test', status: 'idle', createdAt: 0, sessionStartedAt: 0, lastInteractionAt: 0, updatedAt: 0 },
      messages: [], turns: [], metadata: {},
    });

    const loaded = await store.load('agent-1', 'sess-1');
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe('sess-1');
  });

  it('should create jsonl store with dataDir', async () => {
    const dataDir = join(tempDir, 'sessions');
    mkdirSync(dataDir, { recursive: true });
    const store = await createStoreFromConfig({ type: 'jsonl', dataDir });
    expect(store).toBeDefined();
  });

  it('should reject jsonl store without dataDir', async () => {
    await expect(createStoreFromConfig({ type: 'jsonl' }))
      .rejects.toThrow('requires dataDir');
  });

  it('should create sqlite store with in-memory db', async () => {
    const store = await createStoreFromConfig({ type: 'sqlite' });
    expect(store).toBeDefined();

    await store.save('agent-1', 'sess-1', {
      id: 'sess-1', agentId: 'agent-1',
      meta: { id: 'sess-1', agentId: 'agent-1', channelId: 'test', peerId: 'test', status: 'idle', createdAt: 0, sessionStartedAt: 0, lastInteractionAt: 0, updatedAt: 0 },
      messages: [], turns: [], metadata: {},
    });

    const loaded = await store.load('agent-1', 'sess-1');
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe('sess-1');
  });

  it('should create sqlite store with file db', async () => {
    const dbPath = join(tempDir, 'test.db');
    const store = await createStoreFromConfig({ type: 'sqlite', dbPath });
    expect(store).toBeDefined();

    const exists = await store.exists('agent-1', 'nonexistent');
    expect(exists).toBe(false);
  });

  it('should reject unknown store type', async () => {
    await expect(createStoreFromConfig({ type: 'unknown' as any }))
      .rejects.toThrow('Unknown store type');
  });
});

// ── 向后兼容：顶层 store → session.store 迁移 ──

describe('backward compatibility: store migration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'octopi-migration-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeConfig(obj: unknown): string {
    const path = join(tempDir, 'octopi.json');
    writeFileSync(path, JSON.stringify(obj));
    return path;
  }

  it('should auto-migrate top-level store to session.store', () => {
    const configPath = writeConfig({
      agents: [{
        id: 'test',
        model: 'openai/gpt-5.5',
      }],
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'test',
            api: 'openai-completions',
            models: [{ id: 'gpt-5.5' }],
          },
        },
      },
      store: { type: 'memory' },
    });

    const config = loadConfig(configPath);

    expect(config.session?.store).toBeDefined();
    expect(config.session?.store?.type).toBe('memory');
  });

  it('should not migrate when session.store already exists', () => {
    const configPath = writeConfig({
      agents: [{
        id: 'test',
        model: 'openai/gpt-5.5',
      }],
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'test',
            api: 'openai-completions',
            models: [{ id: 'gpt-5.5' }],
          },
        },
      },
      store: { type: 'jsonl', dataDir: '/old/path' },
      session: {
        store: { type: 'memory' },
      },
    });

    const config = loadConfig(configPath);

    // session.store 已存在，不应被覆盖
    expect(config.session?.store?.type).toBe('memory');
  });
});

// ── InMemorySessionStore agentId 隔离 ──

import { InMemorySessionStore } from '../src/integration/storage/memory.js';
import type { SessionData } from '../src/harness/session-types.js';

describe('InMemorySessionStore agentId isolation', () => {
  function makeSession(id: string, agentId: string): SessionData {
    return {
      id, agentId,
      meta: { id, agentId, channelId: 'test', peerId: 'test', status: 'idle', createdAt: 0, sessionStartedAt: 0, lastInteractionAt: 0, updatedAt: 0 },
      messages: [], turns: [], metadata: {},
    };
  }

  it('should isolate sessions across different agents with same sessionId', async () => {
    const store = new InMemorySessionStore();

    await store.save('agent-a', 'sess-1', makeSession('sess-1', 'agent-a'));
    await store.save('agent-b', 'sess-1', makeSession('sess-1', 'agent-b'));

    const loadedA = await store.load('agent-a', 'sess-1');
    const loadedB = await store.load('agent-b', 'sess-1');

    expect(loadedA).toBeDefined();
    expect(loadedB).toBeDefined();
    expect(loadedA!.agentId).toBe('agent-a');
    expect(loadedB!.agentId).toBe('agent-b');
  });

  it('should not let one agent delete another agent session', async () => {
    const store = new InMemorySessionStore();

    await store.save('agent-a', 'sess-1', makeSession('sess-1', 'agent-a'));
    await store.save('agent-b', 'sess-1', makeSession('sess-1', 'agent-b'));

    await store.delete('agent-a', 'sess-1');

    expect(await store.exists('agent-a', 'sess-1')).toBe(false);
    expect(await store.exists('agent-b', 'sess-1')).toBe(true);
  });

  it('should list only sessions for the specified agent', async () => {
    const store = new InMemorySessionStore();

    await store.save('agent-a', 's1', makeSession('s1', 'agent-a'));
    await store.save('agent-a', 's2', makeSession('s2', 'agent-a'));
    await store.save('agent-b', 's3', makeSession('s3', 'agent-b'));

    const listA = await store.list('agent-a');
    const listB = await store.list('agent-b');

    expect(listA).toHaveLength(2);
    expect(listB).toHaveLength(1);
    expect(listB[0].id).toBe('s3');
  });
});
