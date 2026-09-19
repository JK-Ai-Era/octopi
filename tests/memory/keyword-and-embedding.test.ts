/**
 * 关键词检索优化 + models.embedding 配置解析测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentDatabase } from '../../src/harness/memory/sqlite/agent-db.js';
import { SqliteMemoryStore } from '../../src/harness/memory/sqlite/memory-store.js';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import {
  tokenizeKeywordQuery,
  scoreKeywordFields,
  buildKeywordLikeSql,
} from '../../src/harness/memory/sqlite/keyword-search.js';
import {
  resolveEmbeddingRuntime,
  createEmbeddingProviderFromModels,
  isEmbeddingEnabled,
} from '../../src/harness/memory/sqlite/embedding-from-models.js';
import type { EmbeddingProvider } from '../../src/harness/memory/sqlite/embedding.js';
import type { ModelsConfig } from '../../src/config.js';

function createMockEmbedding(dimensions = 32): EmbeddingProvider {
  function textToVec(text: string): number[] {
    const vec = new Array(dimensions).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % dimensions] += text.charCodeAt(i) / 1000;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? vec.map((v) => v / norm) : vec;
  }
  return {
    name: 'mock',
    dimensions,
    embed: async (text: string) => textToVec(text),
    embedBatch: async (texts: string[]) => texts.map(textToVec),
  };
}

describe('tokenizeKeywordQuery', () => {
  it('splits latin tokens and keeps full words', () => {
    const tokens = tokenizeKeywordQuery('sqlite vector search');
    expect(tokens).toContain('sqlite');
    expect(tokens).toContain('vector');
  });

  it('generates CJK bigrams from Chinese queries', () => {
    const tokens = tokenizeKeywordQuery('技术栈选择');
    expect(tokens).toContain('技术栈选择');
    expect(tokens).toContain('技术');
    expect(tokens).toContain('术栈');
    expect(tokens).toContain('栈选');
    expect(tokens).toContain('选择');
  });
});

describe('scoreKeywordFields / buildKeywordLikeSql', () => {
  it('scores tags and future_use hits even when content lacks the term', () => {
    const tokens = tokenizeKeywordQuery('技术栈 选择 优先');
    const score = scoreKeywordFields(
      {
        content: '技术选型应多种技术都考虑，不局限于单一语言或框架',
        tags: ['技术选型', '多语言', '框架选择', '技术栈'],
        futureUse: '当进行技术选型时，综合评估多种技术栈的优劣，根据项目具体需求选择最合适的方案',
      },
      tokens,
    );
    expect(score).toBeGreaterThan(0);
  });

  it('builds multi-column LIKE SQL', () => {
    const { sql, params } = buildKeywordLikeSql(['技术栈', '选择']);
    expect(sql).toContain('content');
    expect(sql).toContain('tags');
    expect(sql).toContain('future_use');
    expect(params.length).toBeGreaterThan(4);
  });
});

describe('models.embedding resolve', () => {
  it('returns null when embedding not configured', () => {
    expect(isEmbeddingEnabled({ providers: {} })).toBe(false);
    expect(createEmbeddingProviderFromModels({ providers: {} })).toBeNull();
  });

  it('returns null when enabled=false', () => {
    const models: ModelsConfig = {
      providers: {},
      embedding: { model: 'bge-m3', enabled: false },
    };
    expect(isEmbeddingEnabled(models)).toBe(false);
    expect(resolveEmbeddingRuntime(models)).toBeNull();
  });

  it('inherits baseUrl/apiKey from models.providers', () => {
    const models: ModelsConfig = {
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          api: 'openai-completions',
          models: [{ id: 'gpt-5.5' }],
        },
      },
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        vectorEngine: 'js',
      },
    };
    const runtime = resolveEmbeddingRuntime(models);
    expect(runtime).not.toBeNull();
    expect(runtime!.provider).not.toBeNull();
    expect(runtime!.type).toBe('openai');
    expect(runtime!.vectorEngine).toBe('js');
    expect(runtime!.dimensions).toBe(1536);
  });

  it('explicit empty apiKey forces keyless even when provider has key', () => {
    const runtime = resolveEmbeddingRuntime({
      providers: {
        openai: {
          baseUrl: 'https://chat.example.com/v1',
          apiKey: 'sk-chat-only',
          api: 'openai-completions',
          models: [{ id: 'gpt-x' }],
        },
      },
      embedding: {
        provider: 'openai',
        model: 'bge-m3',
        apiKey: '',
        dimensions: 1024,
      },
    });
    expect(runtime!.provider).not.toBeNull();
    // provider created; keyless path does not throw at create time
  });

  it('supports remote openai-compatible without any apiKey', () => {
    const runtime = resolveEmbeddingRuntime({
      providers: {},
      embedding: {
        type: 'openai',
        baseUrl: 'https://embed.lan.example/v1',
        apiKey: '',
        model: 'bge-m3',
        dimensions: 1024,
      },
    });
    expect(runtime!.provider).not.toBeNull();
    expect(runtime!.type).toBe('openai');
  });

  it('supports generic http mapping type', () => {
    const runtime = resolveEmbeddingRuntime({
      providers: {},
      embedding: {
        type: 'http',
        baseUrl: 'https://embed.example.com',
        path: '/v1/embed',
        model: 'bge-m3',
        dimensions: 1024,
        supportsBatch: false,
        request: {
          inputField: 'texts',
          modelField: 'model',
          embeddingsPath: 'vectors',
        },
      },
    });
    expect(runtime!.type).toBe('http');
    expect(runtime!.provider).not.toBeNull();
  });

  it('infers ollama type from baseUrl', () => {
    const runtime = resolveEmbeddingRuntime({
      providers: {},
      embedding: {
        model: 'bge-m3',
        baseUrl: 'http://localhost:11434',
        dimensions: 1024,
      },
    });
    expect(runtime!.type).toBe('ollama');
  });
});

describe('HttpEmbeddingProvider generic mapping', () => {
  it('parses custom embeddingsPath without auth header', async () => {
    const { createEmbeddingProvider } = await import(
      '../../src/harness/memory/sqlite/embedding.js'
    );
    const provider = createEmbeddingProvider({
      type: 'http',
      endpoint: 'http://127.0.0.1:9', // 不可达；仅验证 create + headers 逻辑不可直接测网络
      path: '/v1/embed',
      model: 'x',
      dimensions: 3,
      apiKey: '',
      request: {
        inputField: 'texts',
        embeddingsPath: 'vectors',
        extraBody: { normalize: true },
      },
    });
    expect(provider).not.toBeNull();
    expect(provider!.dimensions).toBe(3);
  });
});

describe('SqliteMemoryStore keyword path (no embedding)', () => {
  let db: AgentDatabase;
  let store: SqliteMemoryStore;

  beforeEach(async () => {
    db = await AgentDatabase.create({ dbPath: ':memory:' });
    store = new SqliteMemoryStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('retrieves memory via tags/future_use when content lacks query words', async () => {
    await store.store({
      type: 'norm',
      content: '技术选型应多种技术都考虑，不局限于单一语言或框架',
      source: 'session:test',
      confidence: 1,
      importance: 0.85,
      tags: ['技术选型', '多语言', '框架选择', '技术栈'],
      status: 'active',
      channel: 'user_directive',
      futureUse:
        '当进行技术选型时，综合评估 Python、TypeScript、Go、Rust 等多种技术栈的优劣，根据项目具体需求选择最合适的方案',
      evidence: '算了，这样选择还是太局限了',
    });

    const results = await store.retrieve({
      text: '技术栈 选择 优先',
      limit: 10,
      includeShadow: true,
      updateAccess: false,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tags).toContain('技术栈');
  });

  it('still ranks higher when content matches directly', async () => {
    await store.store({
      type: 'fact',
      content: '项目技术栈优先选用 TypeScript',
      source: 's1',
      confidence: 0.9,
      importance: 0.5,
      tags: [],
      status: 'active',
      channel: 'admin',
      evidence: 'x',
    });
    await store.store({
      type: 'norm',
      content: '选型需综合评估',
      source: 's2',
      confidence: 0.9,
      importance: 0.9,
      tags: ['技术栈'],
      status: 'active',
      channel: 'admin',
      evidence: 'y',
    });

    const results = await store.retrieve({
      text: '技术栈',
      limit: 10,
      updateAccess: false,
    });
    expect(results.length).toBe(2);
    expect(results[0].content).toContain('技术栈');
  });
});

describe('SqliteMemoryStore with embedding (JS hybrid fallback)', () => {
  let db: AgentDatabase;
  let store: SqliteMemoryStore;

  beforeEach(async () => {
    db = await AgentDatabase.create({ dbPath: ':memory:' });
    store = new SqliteMemoryStore(db, {
      embeddingProvider: createMockEmbedding(32),
      vectorEngine: 'js',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('writes embedding on store and retrieves via hybrid path', async () => {
    const id = await store.store({
      type: 'method',
      content: 'Vitest mock 需要先 import',
      source: 's',
      confidence: 0.8,
      importance: 0.7,
      tags: ['vitest'],
      status: 'active',
      channel: 'admin',
      evidence: 'unit',
    });

    const row = db.raw.prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as {
      embedding: string | null;
    };
    expect(row.embedding).toBeTruthy();

    const results = await store.retrieve({ text: 'Vitest mock', limit: 5, updateAccess: false });
    expect(results.some((r) => r.id === id)).toBe(true);
    expect(store.vectorEngineActive).toBe('js');
  });

  it('backfills missing embeddings', async () => {
    // 先无 embedding 写入（新 store 实例）
    const bare = new SqliteMemoryStore(db);
    await bare.store({
      type: 'fact',
      content: 'legacy memory without vector',
      source: 's',
      confidence: 0.5,
      importance: 0.5,
      tags: [],
      status: 'active',
      channel: 'admin',
      evidence: 'e',
    });

    const n = await store.backfillEmbeddings(10);
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

describe('SqliteMemoryStore sqlite-vec path', () => {
  it('uses vec KNN when extension loads', async () => {
    const db = await AgentDatabase.create({
      dbPath: ':memory:',
      sqliteVec: true,
      vectorDimensions: 32,
    });
    if (!db.sqliteVecEnabled) {
      // 环境未装 sqlite-vec：跳过（optionalDependency）
      db.close();
      return;
    }
    const store = new SqliteMemoryStore(db, {
      embeddingProvider: createMockEmbedding(32),
      vectorEngine: 'auto',
    });
    const id = await store.store({
      type: 'method',
      content: 'vector path memory about cosine search',
      source: 's',
      confidence: 0.9,
      importance: 0.8,
      tags: ['vector'],
      status: 'active',
      channel: 'admin',
      evidence: 'e',
    });
    expect(store.vectorEngineActive).toBe('sqlite-vec');
    const results = await store.retrieve({ text: 'cosine search vector', limit: 5, updateAccess: false });
    expect(results.some((r) => r.id === id)).toBe(true);
    db.close();
  });
});

describe('InMemoryMemoryStore keyword multi-field', () => {
  it('matches tags/future_use', async () => {
    const store = new InMemoryMemoryStore();
    await store.store({
      type: 'norm',
      content: '技术选型应多种技术都考虑',
      source: 's',
      confidence: 1,
      importance: 0.8,
      tags: ['技术栈'],
      status: 'active',
      channel: 'user_directive',
      futureUse: '选择技术栈时综合评估',
    });

    const results = await store.retrieve({ text: '技术栈', limit: 5, updateAccess: false });
    expect(results.length).toBe(1);
  });
});
