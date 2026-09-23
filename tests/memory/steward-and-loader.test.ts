import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SubsystemLoader } from '../../src/harness/autonomous-subsystem/loader.js';
import { planSoftDeletes } from '../../src/subsystems/memory-steward/shared/policy.js';
import { handler as governHandler } from '../../src/subsystems/memory-steward/govern/handler.js';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import type { MemoryEntry } from '../../src/harness/memory/types.js';

function entry(partial: Partial<MemoryEntry> & { id: string; content: string }): MemoryEntry {
  return {
    type: 'fact',
    source: 'test',
    confidence: 0.8,
    importance: 0.7,
    accessCount: 0,
    lastAccessedAt: Date.now(),
    createdAt: Date.now(),
    decayFactor: 1,
    tags: [],
    status: 'active',
    channel: 'decision',
    deleted: false,
    evidence: 'quoted evidence for govern tests',
    anchors: ['anchor'],
    futureUse: 'when relevant apply this proposition',
    ...partial,
  };
}

describe('subsystem loader multi-spec package', () => {
  it('loads nested specs and skips shared/', async () => {
    const root = join(tmpdir(), `octopi-subsys-${Date.now()}`);
    const pkg = join(root, 'memory-steward');
    mkdirSync(join(pkg, 'shared'), { recursive: true });
    mkdirSync(join(pkg, 'backfill'), { recursive: true });
    mkdirSync(join(pkg, 'govern'), { recursive: true });
    writeFileSync(join(pkg, 'shared', 'policy.ts'), 'export const x = 1;\n');
    writeFileSync(join(pkg, 'backfill', 'handler.ts'), 'export const handler = async () => ({ signals: [] });\nexport default { handler };\n');
    writeFileSync(join(pkg, 'govern', 'handler.ts'), 'export const handler = async () => ({ signals: [] });\nexport default { handler };\n');
    writeFileSync(
      join(pkg, 'backfill', 'config.yaml'),
      [
        'id: memory.steward.backfill',
        'name: BF',
        'act: { mode: inject }',
        'signal: { severity: info, channel: [event] }',
        'boundary: { visibility: structured, authority: act, security: trusted }',
        'think: { implementation: code, strategy: deterministic }',
        'sense: { source: eventBus, isolation: structured, filter: { events: [memory.steward.backfill.request] } }',
      ].join('\n'),
    );
    writeFileSync(join(pkg, 'govern', 'config.yaml'), [
      'id: memory.steward.govern',
      'name: GV',
      'act: { mode: inject }',
      'signal: { severity: info, channel: [event] }',
      'boundary: { visibility: isolated, authority: act, security: trusted }',
      'think: { implementation: code, strategy: deterministic }',
      'sense: { source: schedule, interval: 60000, isolation: isolated }',
    ].join('\n'));

    const loader = new SubsystemLoader({ builtinDir: root });
    const result = await loader.loadAll();
    rmSync(root, { recursive: true, force: true });

    const ids = result.specs.map((s) => s.id).sort();
    expect(ids).toContain('memory.steward.backfill');
    expect(ids).toContain('memory.steward.govern');
    const bf = result.specs.find((s) => s.id === 'memory.steward.backfill');
    expect(bf?.packageId).toBe('memory-steward');
  });

  it('ships built-in memory-steward package', async () => {
    const loader = new SubsystemLoader({
      builtinDir: join(process.cwd(), 'src', 'subsystems'),
    });
    const result = await loader.loadAll();
    const ids = result.specs.map((s) => s.id);
    expect(ids).toContain('memory.steward.backfill');
    expect(ids).toContain('memory.steward.govern');
  });
});

describe('govern soft-delete plan', () => {
  it('protects user_directive high confidence', () => {
    const now = Date.now();
    const plan = planSoftDeletes(
      [
        entry({
          id: 'a',
          content: '禁止提交 octopi.json',
          channel: 'user_directive',
          confidence: 0.95,
          type: 'norm',
          createdAt: now - 10 * 86400000,
          lastAccessedAt: now,
          accessCount: 5,
        }),
      ],
      undefined,
      now,
    );
    expect(plan.find((p) => p.id === 'a')).toBeUndefined();
  });

  it('soft-deletes expired shadow', () => {
    const now = Date.now();
    const plan = planSoftDeletes(
      [
        entry({
          id: 'b',
          content: 'When working on module alpha prefer early returns',
          status: 'shadow',
          channel: 'model_inference',
          confidence: 0.4,
          importance: 0.4,
          createdAt: now - 30 * 86400000,
          lastAccessedAt: now - 30 * 86400000,
          accessCount: 0,
          evidence: '"alpha module style note"',
          anchors: ['alpha'],
          futureUse: 'When editing alpha module prefer early returns',
        }),
      ],
      undefined,
      now,
    );
    expect(plan.some((p) => p.id === 'b' && p.ruleId === 'shadow_expired')).toBe(true);
  });

  it('marks duplicate loser', () => {
    const now = Date.now();
    const shared = 'Memory backend uses SqliteMemoryStore at agent.db';
    const plan = planSoftDeletes(
      [
        entry({
          id: 'old',
          content: shared,
          confidence: 0.6,
          importance: 0.5,
          createdAt: now - 3 * 86400000,
          lastAccessedAt: now - 3 * 86400000,
        }),
        entry({
          id: 'new',
          content: shared,
          confidence: 0.9,
          importance: 0.8,
          createdAt: now - 2 * 86400000,
          lastAccessedAt: now - 2 * 86400000,
        }),
      ],
      { protectWindowMs: 1000 },
      now,
    );
    const loser = plan.find((p) => p.ruleId === 'duplicate_loser');
    expect(loser?.id).toBe('old');
    expect(loser?.winnerId).toBe('new');
  });
});

describe('govern wires MemoryStore.decay before soft-delete plan', () => {
  async function seedIdleFact(store: InMemoryMemoryStore): Promise<string> {
    const id = await store.store({
      type: 'fact',
      content: 'Memory backend uses SqliteMemoryStore on agent.db for this agent',
      source: 'test',
      confidence: 0.7,
      importance: 0.6,
      tags: ['fact', 'decision'],
      channel: 'decision',
      status: 'active',
      evidence: '"use SqliteMemoryStore on agent.db"',
      anchors: ['SqliteMemoryStore', 'agent.db'],
      futureUse: 'When configuring memory backend use SqliteMemoryStore',
    });
    // 超过 decay 窗口（30d）未访问
    await store.update(id, { lastAccessedAt: Date.now() - 40 * 86_400_000 });
    return id;
  }

  it('decays idle entries and reports count in signal', async () => {
    const store = new InMemoryMemoryStore();
    const id = await seedIdleFact(store);

    const out = await governHandler({}, { memoryStore: store });

    const after = await store.get(id);
    expect(after?.decayFactor).toBeLessThan(1);
    expect(after?.decayFactor).toBeCloseTo(0.95, 5);

    const data = out.signals[0]?.data as { decayed?: number } | undefined;
    expect(data?.decayed).toBe(1);
    expect(out.act?.messages?.[0]?.content).toContain('decayed=1');
  });

  it('skips decay on dryRun and leaves decayFactor untouched', async () => {
    const store = new InMemoryMemoryStore();
    const id = await seedIdleFact(store);

    const out = await governHandler(
      {},
      { memoryStore: store, __subsystem_config__: { softDelete: { dryRun: true } } },
    );

    const after = await store.get(id);
    expect(after?.decayFactor).toBe(1);
    const data = out.signals[0]?.data as { decayed?: number; dryRun?: boolean } | undefined;
    expect(data?.decayed).toBe(0);
    expect(data?.dryRun).toBe(true);
    expect(out.act?.messages?.[0]?.content).toContain('dryRun=true');
  });
});
