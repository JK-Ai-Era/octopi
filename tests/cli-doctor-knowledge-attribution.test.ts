/**
 * R4 归属回填 —— doctor 知识面归属归一化（KN012–KN015，arch/multi-tenancy.md T3d/§9.1-18）：
 * 错域残行（断言收口前写落 DEFAULT 的假成功形状）移归归属域；重复残行删除；歧义只报不动。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const prevHome = process.env.OCTOPI_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'octopi-doctor-attribution-'));
  mkdirSync(join(home, 'knowledge'), { recursive: true });
  mkdirSync(join(home, 'sessions'), { recursive: true });
  process.env.OCTOPI_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.OCTOPI_HOME;
  else process.env.OCTOPI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

interface Seed {
  tenantA: string;
  agentA: string;
  runSql: (sql: string, ...params: (string | number)[]) => void;
  close: () => Promise<void>;
}

async function seed(): Promise<Seed> {
  const { RegistryService } = await import(
    '../packages/engine/src/harness/governance/registry/service.js'
  );
  const reg = await RegistryService.create({ dbPath: join(home, 'registry.db') });
  const { tenant, user } = reg.registerUser({ name: 'alice' });
  const agent = reg.createAgent({
    tenantId: tenant.tenantId,
    ownerUserId: user.userId,
    name: 'agent-a',
    visibility: 'tenant',
  });
  reg.close();
  const { KnowledgeDatabase } = await import(
    '../packages/engine/src/harness/knowledge/db.js'
  );
  const db = await KnowledgeDatabase.create({
    dbPath: join(home, 'knowledge', 'knowledge.db'),
    sqliteVec: false,
  });
  return {
    tenantA: tenant.tenantId,
    agentA: agent.agentId,
    runSql: (sql: string, ...params: (string | number)[]) => {
      db.raw.prepare(sql).run(...params);
    },
    close: async () => {
      db.close();
    },
  };
}

describe('doctor 知识面归属归一化（R4 归属回填）', () => {
  it('全对齐 → ok；agent 键错域行移归 agent 归属域，幂等', async () => {
    const s = await seed();
    try {
      // 对齐行：agent 归属域内（应报 ok）
      s.runSql(
        `INSERT INTO knowledge_project_agents (tenant_id, gateway_id, local_agent_id, project_key, created_at)
         VALUES (?, 'gw1', ?, 'p-ok', 0)`,
        s.tenantA,
        s.agentA,
      );
      // 错域残行：DEFAULT 域里的 tenant agent 挂载（假成功形状）
      s.runSql(
        `INSERT INTO knowledge_project_agents (tenant_id, gateway_id, local_agent_id, project_key, created_at)
         VALUES ('default', 'gw1', ?, 'p-stray', 0)`,
        s.agentA,
      );
      const { detectKnowledgeAttribution, applyKnowledgeAttributionFixes } = await import(
        '../src/cli/doctor/knowledge-attribution.js'
      );
      const before = await detectKnowledgeAttribution();
      expect(before.some((f) => f.id === 'KN012' && f.severity === 'warn')).toBe(true);

      const fixed = await applyKnowledgeAttributionFixes({ dryRun: false });
      expect(fixed.findings[0]?.message).toMatch(/moved 1 row/);

      // 行移归归属域
      const { KnowledgeDatabase } = await import(
        '../packages/engine/src/harness/knowledge/db.js'
      );
      const db = await KnowledgeDatabase.create({
        dbPath: join(home, 'knowledge', 'knowledge.db'),
        readOnly: true,
        skipMigrate: true,
        sqliteVec: false,
      });
      try {
        const rows = db.raw
          .prepare('SELECT tenant_id, project_key FROM knowledge_project_agents ORDER BY project_key')
          .all() as Array<{ tenant_id: string; project_key: string }>;
        expect(rows).toEqual([
          { tenant_id: s.tenantA, project_key: 'p-ok' },
          { tenant_id: s.tenantA, project_key: 'p-stray' },
        ]);
      } finally {
        db.close();
      }

      // 幂等：再跑检测全对齐
      const after = await detectKnowledgeAttribution();
      expect(after.some((f) => f.severity === 'ok')).toBe(true);
      expect(after.some((f) => f.severity === 'warn')).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('目标域已有同键行 → 删残行保规范行（不撞主键）', async () => {
    const s = await seed();
    try {
      s.runSql(
        `INSERT INTO knowledge_agent_visibility (tenant_id, gateway_id, local_agent_id, source_id, op, created_at)
         VALUES (?, 'gw1', ?, 's1', 'exclude', 0)`,
        s.tenantA,
        s.agentA,
      );
      s.runSql(
        `INSERT INTO knowledge_agent_visibility (tenant_id, gateway_id, local_agent_id, source_id, op, created_at)
         VALUES ('default', 'gw1', ?, 's1', 'include', 0)`,
        s.agentA,
      );
      const { applyKnowledgeAttributionFixes, detectKnowledgeAttribution } = await import(
        '../src/cli/doctor/knowledge-attribution.js'
      );
      const fixed = await applyKnowledgeAttributionFixes({ dryRun: false });
      expect(fixed.findings[0]?.message).toMatch(/1 duplicate residue row\(s\) dropped/);
      const after = await detectKnowledgeAttribution();
      expect(after.some((f) => f.severity === 'warn')).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('project 域源对齐项目行域（M1）；同 key 多域歧义只报不动（KN015）', async () => {
    const s = await seed();
    try {
      s.runSql(
        `INSERT INTO knowledge_projects (tenant_id, project_key, visibility, created_at, updated_at)
         VALUES (?, 'p1', 'private', 0, 0)`,
        s.tenantA,
      );
      // 源错域（DEFAULT）而项目在 tenantA → 应移归
      s.runSql(
        `INSERT INTO knowledge_sources (id, tenant_id, kind, location, scope_level, scope_key, display_name, created_at, updated_at)
         VALUES ('src-move', 'default', 'file', '/tmp/a.md', 'project', 'p1', 'A', 0, 0)`,
      );
      // 歧义：项目同 key 双域、源在第三域 → 跳过
      s.runSql(
        `INSERT INTO knowledge_projects (tenant_id, project_key, visibility, created_at, updated_at)
         VALUES ('default', 'p2', 'private', 0, 0)`,
      );
      s.runSql(
        `INSERT INTO knowledge_projects (tenant_id, project_key, visibility, created_at, updated_at)
         VALUES (?, 'p2', 'private', 0, 0)`,
        s.tenantA,
      );
      s.runSql(
        `INSERT INTO knowledge_sources (id, tenant_id, kind, location, scope_level, scope_key, display_name, created_at, updated_at)
         VALUES ('src-skip', 'platform', 'file', '/tmp/b.md', 'project', 'p2', 'B', 0, 0)`,
      );
      const { detectKnowledgeAttribution, applyKnowledgeAttributionFixes } = await import(
        '../src/cli/doctor/knowledge-attribution.js'
      );
      const before = await detectKnowledgeAttribution();
      expect(before.some((f) => f.id === 'KN013' && f.severity === 'warn')).toBe(true);
      expect(before.some((f) => f.id === 'KN015')).toBe(true);

      await applyKnowledgeAttributionFixes({ dryRun: false });
      const { KnowledgeDatabase } = await import(
        '../packages/engine/src/harness/knowledge/db.js'
      );
      const db = await KnowledgeDatabase.create({
        dbPath: join(home, 'knowledge', 'knowledge.db'),
        readOnly: true,
        skipMigrate: true,
        sqliteVec: false,
      });
      try {
        const rows = db.raw
          .prepare('SELECT id, tenant_id FROM knowledge_sources ORDER BY id')
          .all() as Array<{ id: string; tenant_id: string }>;
        expect(rows).toEqual([
          { id: 'src-move', tenant_id: s.tenantA },
          { id: 'src-skip', tenant_id: 'platform' }, // 歧义不动
        ]);
      } finally {
        db.close();
      }
    } finally {
      await s.close();
    }
  });

  it('session overlay 行：可解析会话移归其 agent 归属域；解析不了只报不动（KN014/KN015）', async () => {
    const s = await seed();
    try {
      writeFileSync(
        join(home, 'sessions', 's-live.state.json'),
        JSON.stringify({ agentId: s.agentA }),
      );
      s.runSql(
        `INSERT INTO knowledge_session_visibility (tenant_id, gateway_id, local_session_id, target_type, target_id, op, created_at)
         VALUES ('default', 'gw1', 's-live', 'project', 'p1', 'include', 0)`,
      );
      s.runSql(
        `INSERT INTO knowledge_session_visibility (tenant_id, gateway_id, local_session_id, target_type, target_id, op, created_at)
         VALUES ('default', 'gw1', 's-ghost', 'project', 'p1', 'include', 0)`,
      );
      const { applyKnowledgeAttributionFixes, detectKnowledgeAttribution } = await import(
        '../src/cli/doctor/knowledge-attribution.js'
      );
      const before = await detectKnowledgeAttribution();
      expect(before.some((f) => f.id === 'KN014')).toBe(true);
      expect(before.some((f) => f.id === 'KN015')).toBe(true);

      await applyKnowledgeAttributionFixes({ dryRun: false });
      const { KnowledgeDatabase } = await import(
        '../packages/engine/src/harness/knowledge/db.js'
      );
      const db = await KnowledgeDatabase.create({
        dbPath: join(home, 'knowledge', 'knowledge.db'),
        readOnly: true,
        skipMigrate: true,
        sqliteVec: false,
      });
      try {
        const rows = db.raw
          .prepare('SELECT local_session_id, tenant_id FROM knowledge_session_visibility ORDER BY local_session_id')
          .all() as Array<{ local_session_id: string; tenant_id: string }>;
        expect(rows).toEqual([
          { local_session_id: 's-ghost', tenant_id: 'default' }, // 解析不了 → 不动
          { local_session_id: 's-live', tenant_id: s.tenantA },
        ]);
      } finally {
        db.close();
      }
    } finally {
      await s.close();
    }
  });

  it('dry-run 只报告不写库', async () => {
    const s = await seed();
    try {
      s.runSql(
        `INSERT INTO knowledge_project_agents (tenant_id, gateway_id, local_agent_id, project_key, created_at)
         VALUES ('default', 'gw1', ?, 'p-stray', 0)`,
        s.agentA,
      );
      const { applyKnowledgeAttributionFixes } = await import(
        '../src/cli/doctor/knowledge-attribution.js'
      );
      const dry = await applyKnowledgeAttributionFixes({ dryRun: true });
      expect(dry.findings[0]?.message).toMatch(/\[dry-run\] would move 1 row/);
      const { KnowledgeDatabase } = await import(
        '../packages/engine/src/harness/knowledge/db.js'
      );
      const db = await KnowledgeDatabase.create({
        dbPath: join(home, 'knowledge', 'knowledge.db'),
        readOnly: true,
        skipMigrate: true,
        sqliteVec: false,
      });
      try {
        const row = db.raw
          .prepare('SELECT tenant_id FROM knowledge_project_agents')
          .get() as { tenant_id: string };
        expect(row.tenant_id).toBe('default'); // 未动
      } finally {
        db.close();
      }
    } finally {
      await s.close();
    }
  });
});
