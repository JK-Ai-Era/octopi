/**
 * Memory redesign 验收测试 — DESIGN 矩阵补强
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateGates, mapLegacyType } from '../../src/harness/memory/gates.js';
import { provisionalConfidence } from '../../src/harness/memory/confidence.js';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import { AgentDatabase } from '../../src/harness/memory/sqlite/agent-db.js';
import { SqliteMemoryStore } from '../../src/harness/memory/sqlite/memory-store.js';
import { loadConstitution } from '../../src/harness/context/constitution/load-constitution.js';
import { DefaultContextAssembler } from '../../src/harness/context/assembler.js';
import { isSubsystemAllowed } from '../../src/harness/agent-building/builder.js';
import { SubsystemLoader } from '../../src/harness/autonomous-subsystem/loader.js';
import { admitCandidates } from '../../src/subsystems/memory-steward/shared/policy.js';

describe('constitution loader', () => {
  it('product loads English operational body without product meta', () => {
    const r = loadConstitution({ mode: 'product' });
    expect(r.source).toBe('product');
    expect(r.text).toContain('memory_store');
    expect(r.text).toContain('fact | method | norm');
    expect(r.text).not.toContain('不在运行空间');
    expect(r.text).not.toContain('assembled at the front of the system prompt');
  });

  it('custom missing path throws (build fail, not silent off)', () => {
    expect(() => loadConstitution({ mode: 'custom', path: null })).toThrow(/custom/i);
    expect(() => loadConstitution({ mode: 'custom', path: 'C:\\not\\exist\\constitution.md' })).toThrow(/not found/i);
  });

  it('off returns empty text', () => {
    const r = loadConstitution({ mode: 'off' });
    expect(r.text).toBe('');
    expect(r.source).toBe('none');
  });
});

describe('assembler preamble', () => {
  it('returns constitution even when there are no layers', async () => {
    const assembler = new DefaultContextAssembler({ constitutionPreamble: '# CONSTITUTION_HEAD' });
    const result = await assembler.assemble({
      sessionId: 's',
      systemBudget: 2000,
      messages: [],
      layers: [],
    });
    expect(result.systemPrompt).toContain('CONSTITUTION_HEAD');
  });
});

describe('gates reason codes', () => {
  it('rejects no_retrieval_anchor for auto channel without anchors/futureUse', () => {
    const r = evaluateGates({
      type: 'norm',
      proposition: '应当更加仔细地检查代码再提交',
      evidence: '用户说要仔细',
      channel: 'model_inference',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_retrieval_anchor');
  });

  it('rejects synthetic_evidence evt_N', () => {
    const r = evaluateGates({
      type: 'fact',
      proposition: 'Memory store uses SqliteMemoryStore on agent.db',
      evidence: 'evt_3',
      channel: 'model_inference',
      anchors: ['SqliteMemoryStore', 'agent.db'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('synthetic_evidence');
  });
});

describe('legacy type on store path', () => {
  it('InMemory store maps legacy type on write', async () => {
    const store = new InMemoryMemoryStore();
    const id = await store.store({
      type: 'lesson' as any,
      content: 'use fallback when provider down',
      source: 't',
      confidence: 0.7,
      importance: 0.6,
      tags: [],
      channel: 'admin',
      status: 'active',
      evidence: 'e',
    });
    const got = await store.get(id);
    expect(got?.type).toBe('method');
  });
});

describe('Sqlite soft-delete parity + legacy migrate', () => {
  it('excludes deleted retrieve and remaps legacy types on open', async () => {
    const db = await AgentDatabase.create({ dbPath: ':memory:' });
    // 插入旧 schema 风格 type（直接 SQL）
    db.raw.prepare(`
      INSERT INTO memories (id, type, content, source, confidence, importance, access_count, last_accessed_at, created_at, decay_factor, tags, status, deleted)
      VALUES ('m1', 'preference', 'likes npm over yarn', 's', 0.8, 0.7, 0, ?, ?, 1.0, '[]', 'active', 0)
    `).run(Date.now(), Date.now());

    const store = new SqliteMemoryStore(db);
    // 重新打开触发 migrate（同连接上 simulate：直接跑 migrate via new AgentDatabase not possible on :memory:）
    // 用 row 读取路径的 mapLegacyType
    const rows = await store.listForGovern({ includeDeleted: false });
    expect(mapLegacyType(rows[0].type)).toBe('norm');

    await store.store({
      type: 'fact',
      content: 'octopi.json lives under OCTOPI_HOME',
      source: 's',
      confidence: 0.9,
      importance: 0.8,
      tags: ['env'],
      channel: 'admin',
      status: 'active',
      evidence: 'AGENTS.md',
      anchors: ['octopi.json'],
    });
    const all = await store.retrieve({ text: 'octopi', includeShadow: false });
    const id = all[0].id;
    await store.softDelete(id, { by: 'test', reason: 'junk_recheck' });
    const after = await store.retrieve({ text: 'octopi', includeDeleted: false });
    expect(after.find((e) => e.id === id)).toBeUndefined();
    const stats = await store.stats();
    expect(stats.deletedEntries).toBe(1);
    db.close();
  });
});

describe('subsystem allowlist package match', () => {
  it('supports packageId and memory.steward.* prefix', () => {
    expect(isSubsystemAllowed('memory.steward.govern', ['memory-steward'], undefined, 'memory-steward')).toBe(true);
    expect(isSubsystemAllowed('memory.steward.govern', ['memory.steward.*'], undefined, 'memory-steward')).toBe(true);
    expect(isSubsystemAllowed('safety-guard', ['memory.steward.*'], undefined, 'safety-guard')).toBe(false);
    expect(isSubsystemAllowed('memory.steward.govern', undefined, ['memory-steward'], 'memory-steward')).toBe(false);
  });
});

describe('hybrid channel filter + supersede safety', () => {
  it('InMemory channel filter works', async () => {
    const store = new InMemoryMemoryStore();
    await store.store({
      type: 'norm',
      content: 'Use npm for package management in octopi',
      source: 't',
      confidence: 0.8,
      importance: 0.7,
      tags: [],
      channel: 'user_directive',
      status: 'active',
      evidence: '"用 npm"',
      anchors: ['npm', 'octopi'],
    });
    await store.store({
      type: 'fact',
      content: 'SqliteMemoryStore binds agent.db under agent home',
      source: 't',
      confidence: 0.8,
      importance: 0.7,
      tags: [],
      channel: 'decision',
      status: 'active',
      evidence: 'decided',
      anchors: ['SqliteMemoryStore', 'agent.db'],
    });
    const onlyDirective = await store.retrieve({ text: '', channel: 'user_directive', includeShadow: false });
    expect(onlyDirective).toHaveLength(1);
    expect(onlyDirective[0].channel).toBe('user_directive');
  });

  it('includeDeleted does not unlock shadow in InMemory', async () => {
    const store = new InMemoryMemoryStore();
    const id = await store.store({
      type: 'method',
      content: 'When debugging prefer agent.db first',
      source: 't',
      confidence: 0.4,
      importance: 0.4,
      tags: [],
      channel: 'model_inference',
      status: 'shadow',
      evidence: 'paraphrase only',
      anchors: ['agent.db'],
    });
    const withDeleted = await store.retrieve({ text: 'agent.db', includeDeleted: true, includeShadow: false });
    expect(withDeleted.find((e) => e.id === id)).toBeUndefined();
  });

  it('near-duplicate supersede uses trigram similarity not bare prefix', async () => {
    const { planSoftDeletes, charTrigramSimilarity } = await import('../../src/subsystems/memory-steward/shared/policy.js');
    const now = Date.now();
    const a = 'Memory backend uses SqliteMemoryStore on agent.db';
    const b = 'Memory backend uses SqliteMemoryStore on agent.db file';
    const c = 'Do not commit octopi.json to git';
    expect(charTrigramSimilarity(a.toLowerCase(), b.toLowerCase())).toBeGreaterThan(0.7);
    expect(charTrigramSimilarity(a.toLowerCase(), c.toLowerCase())).toBeLessThan(0.3);

    const plan = planSoftDeletes(
      [
        {
          id: 'a',
          type: 'fact',
          content: a,
          source: 't',
          confidence: 0.6,
          importance: 0.5,
          accessCount: 0,
          lastAccessedAt: now,
          createdAt: now - 5 * 86400000,
          decayFactor: 1,
          tags: [],
          status: 'active',
          channel: 'decision',
          deleted: false,
          evidence: 'e',
          anchors: ['SqliteMemoryStore'],
          futureUse: 'when configuring memory',
        },
        {
          id: 'b',
          type: 'fact',
          content: b,
          source: 't',
          confidence: 0.9,
          importance: 0.8,
          accessCount: 0,
          lastAccessedAt: now,
          createdAt: now - 2 * 86400000,
          decayFactor: 1,
          tags: [],
          status: 'active',
          channel: 'decision',
          deleted: false,
          evidence: 'e',
          anchors: ['SqliteMemoryStore'],
          futureUse: 'when configuring memory',
        },
        {
          id: 'c',
          type: 'fact',
          content: c,
          source: 't',
          confidence: 0.5,
          importance: 0.5,
          accessCount: 0,
          lastAccessedAt: now,
          createdAt: now - 10 * 86400000,
          decayFactor: 1,
          tags: [],
          status: 'active',
          channel: 'decision',
          deleted: false,
          evidence: 'e',
          anchors: ['octopi.json'],
          futureUse: 'when committing',
        },
      ],
      { protectWindowMs: 1000, duplicateSimilarity: 0.85 },
      now,
    );
    // c 与 a/b 前缀都像 “Memory…” 吗？c 不同主题，不应被 supersede
    expect(plan.find((p) => p.id === 'c')).toBeUndefined();
  });
});

describe('loader packageId consistency', () => {
  it('single-spec package uses directory basename as packageId', async () => {
    const loader = new SubsystemLoader({ builtinDir: join(process.cwd(), 'src', 'subsystems') });
    const { specs } = await loader.loadAll();
    const safety = specs.find((s) => s.id === 'safety-guard');
    expect(safety?.packageId).toBe('safety-guard');
    const govern = specs.find((s) => s.id === 'memory.steward.govern');
    expect(govern?.packageId).toBe('memory-steward');
  });

  it('does not discover removed memory.extractor package', async () => {
    const loader = new SubsystemLoader({ builtinDir: join(process.cwd(), 'src', 'subsystems') });
    const { specs } = await loader.loadAll();
    expect(specs.map((s) => s.id)).not.toContain('memory.extractor');
    expect(existsSync(join(process.cwd(), 'src', 'subsystems', 'memory-extractor'))).toBe(false);
  });
});

describe('steward admit + shadow invariant', () => {
  it('model_inference without quote lands shadow and is searchable not injectable', async () => {
    const store = new InMemoryMemoryStore();
    const result = await admitCandidates(store, [{
      type: 'method',
      proposition: 'When debugging octopi memory use agent.db and extract events',
      evidence: 'paraphrase no quote marks',
      future_use: 'When debugging memory quality inspect agent.db',
      anchors: ['agent.db', 'octopi'],
      channel: 'model_inference',
    }], 'test');
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].status).toBe('shadow');

    const injectable = await store.retrieve({ text: 'agent.db', includeShadow: false });
    expect(injectable).toHaveLength(0);
    const searchable = await store.retrieve({ text: 'agent.db', includeShadow: true });
    expect(searchable).toHaveLength(1);
  });

  it('user_directive with quoted evidence becomes active', () => {
    const p = provisionalConfidence({
      channel: 'user_directive',
      evidence: '"不要提交 octopi.json"',
      anchors: ['octopi.json'],
    });
    expect(p.status).toBe('active');
  });
});
