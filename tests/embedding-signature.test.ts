/**
 * 向量空间签名（embeddingSignature）与换模型后的重建行为
 *
 * 核心不变量：
 * 1. 签名只由「协议 + 端点 + 模型 + 维度」决定；path 不影响（同一空间不同路由）
 * 2. 换签名后，旧向量不再被检索命中（否则会拿不同空间的向量做余弦比较）
 * 3. 换签名后，旧向量被判为「待重嵌」并真的被重算
 * 4. 维度变化时 vec 表被重建，而不是静默写入失败
 * 5. 签名列迁移在旧库上幂等
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  embeddingSignature,
  createEmbeddingProvider,
} from '@octopi-agent/engine/harness/memory/sqlite/embedding.js';
import { AgentDatabase } from '@octopi-agent/engine/harness/memory/sqlite/agent-db.js';
import { SqliteMemoryStore } from '@octopi-agent/engine/harness/memory/sqlite/memory-store.js';
import {
  vecTableDimensions,
  vecTableNeedsRebuild,
} from '@octopi-agent/engine/harness/memory/sqlite/sqlite-vec.js';
import type { EmbeddingProvider } from '@octopi-agent/engine/harness/memory/sqlite/embedding.js';

describe('embeddingSignature', () => {
  it('同一份配置产出同一个签名', () => {
    const a = embeddingSignature({
      type: 'openai',
      endpoint: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
    const b = embeddingSignature({
      type: 'openai',
      endpoint: 'https://api.openai.com/v1/',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
    expect(a).toBe(b);
  });

  it('端点、模型、维度、协议任一变化都换签名', () => {
    const base = {
      type: 'openai',
      endpoint: 'https://api.example.com/v1',
      model: 'm1',
      dimensions: 1024,
    };
    const changed = [
      { ...base, endpoint: 'https://api.example.com/v2' },
      { ...base, model: 'm2' },
      { ...base, dimensions: 1536 },
      { ...base, type: 'ollama' },
    ];
    for (const c of changed) {
      expect(embeddingSignature(c)).not.toBe(embeddingSignature(base));
    }
  });

  it('host 大小写与尾部斜杠被规范化，path 不参与签名', () => {
    const a = embeddingSignature({
      type: 'openai',
      endpoint: 'HTTPS://API.Example.com/v1',
      model: 'm',
      dimensions: 8,
    });
    const b = embeddingSignature({
      type: 'openai',
      endpoint: 'https://api.example.com/v1',
      model: 'm',
      dimensions: 8,
    });
    expect(a).toBe(b);

    // path 只决定路由：/embeddings 与自定义 path 仍是同一空间
    const p1 = createEmbeddingProvider({
      type: 'openai',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      dimensions: 8,
    });
    const p2 = createEmbeddingProvider({
      type: 'openai',
      baseUrl: 'https://api.example.com/v1',
      path: '/custom/embeddings',
      model: 'm',
      dimensions: 8,
    });
    expect(p1?.signature).toBe(p2?.signature);
  });

  it('内置 provider 都带签名（第三方 stub 可缺省）', () => {
    const p = createEmbeddingProvider({
      type: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'bge-m3',
      dimensions: 1024,
    });
    expect(p?.signature).toBeTruthy();
  });
});

/** 可指定签名/维度的假 provider */
function stub(signature: string | undefined, dimensions = 4): EmbeddingProvider {
  return {
    name: 'stub',
    dimensions,
    ...(signature ? { signature } : {}),
    async embed() {
      return Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0));
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0)));
    },
  };
}

describe('SqliteMemoryStore — 签名过滤与重建', () => {
  let db: AgentDatabase;

  beforeEach(async () => {
    db = await AgentDatabase.create({ dbPath: ':memory:' });
  });

  afterEach(() => {
    db.close();
  });

  it('写入时记录签名，未启用签名时行为不变', async () => {
    const store = new SqliteMemoryStore(db, { embeddingProvider: stub(undefined) });
    await store.store({
      type: 'fact',
      content: 'x',
      source: 's',
      confidence: 0.5,
      importance: 0.5,
      tags: [],
    });
    const row = db.raw.prepare('SELECT embedding_signature FROM memories').get() as {
      embedding_signature: string | null;
    };
    // 无签名 provider → 不记签名（旧行为）
    expect(row.embedding_signature).toBeNull();
  });

  it('带签名的写入把签名写进列', async () => {
    const store = new SqliteMemoryStore(db, {
      embeddingProvider: stub('sig-a'),
      embeddingSignature: 'sig-a',
    });
    await store.store({
      type: 'fact',
      content: '契约优先',
      source: 's',
      confidence: 0.5,
      importance: 0.5,
      tags: [],
    });
    const row = db.raw.prepare('SELECT embedding_signature FROM memories').get() as {
      embedding_signature: string | null;
    };
    expect(row.embedding_signature).toBe('sig-a');
  });

  it('换签名后旧向量不再被检索命中', async () => {
    // 先以 sig-a 写入并建立向量
    const storeA = new SqliteMemoryStore(db, {
      embeddingProvider: stub('sig-a'),
      embeddingSignature: 'sig-a',
    });
    await storeA.store({
      type: 'fact',
      content: 'alpha',
      source: 's',
      confidence: 0.4,
      importance: 0.4,
      tags: [],
    });

    // 以 sig-b 打开同一库：旧向量属于另一空间，必须完全不出现在结果里
    const storeB = new SqliteMemoryStore(db, {
      embeddingProvider: stub('sig-b'),
      embeddingSignature: 'sig-b',
    });
    const hits = await storeB.retrieve({ text: 'alpha', limit: 5 });
    expect(hits).toEqual([]);
  });

  it('换签名后待重嵌计数可见，且回填真的重算', async () => {
    const storeA = new SqliteMemoryStore(db, {
      embeddingProvider: stub('sig-a'),
      embeddingSignature: 'sig-a',
    });
    await storeA.store({
      type: 'fact',
      content: 'beta',
      source: 's',
      confidence: 0.4,
      importance: 0.4,
      tags: [],
    });

    const storeB = new SqliteMemoryStore(db, {
      embeddingProvider: stub('sig-b'),
      embeddingSignature: 'sig-b',
    });
    expect(storeB.pendingEmbeddingCount()).toBe(1);

    await storeB.backfillEmbeddings(10);
    expect(storeB.pendingEmbeddingCount()).toBe(0);
    const row = db.raw.prepare('SELECT embedding_signature FROM memories').get() as {
      embedding_signature: string;
    };
    expect(row.embedding_signature).toBe('sig-b');
  });
});

describe('vec 表维度重建判断（纯逻辑，不依赖扩展）', () => {
  it('维度相同不重建；维度不同必须重建', () => {
    const ddl8 = 'CREATE VIRTUAL TABLE memory_vec USING vec0(memory_id TEXT PRIMARY KEY, embedding float[8] distance_metric=cosine)';
    expect(vecTableNeedsRebuild(ddl8, 8)).toBe(false);
    expect(vecTableNeedsRebuild(ddl8, 16)).toBe(true);
  });

  it('表不存在（无 DDL）时不判定为重建（交给 CREATE）', () => {
    expect(vecTableNeedsRebuild(undefined, 16)).toBe(false);
  });

  it('DDL 无法识别维度时不贸然 DROP（保守返回不重建）', () => {
    expect(vecTableNeedsRebuild('CREATE TABLE memory_vec (x TEXT)', 16)).toBe(false);
  });

  it('能读出声明维度', () => {
    expect(vecTableDimensions('... embedding float[1024] ...')).toBe(1024);
    expect(vecTableDimensions(undefined)).toBeNull();
  });
});

describe('遗留库迁移幂等', () => {
  it('重复 open 同一个带签名的库不报错，且列保持单份', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const tmp = mkdtempSync('/tmp/octopi-sig-');
    const dbPath = join(tmp, 'agent.db');
    try {
      for (let i = 0; i < 3; i++) {
        const db = await AgentDatabase.create({ dbPath });
        db.close();
      }
      const db = await AgentDatabase.create({ dbPath });
      const cols = db.raw.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names.filter((n) => n === 'embedding_signature')).toHaveLength(1);
      db.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
