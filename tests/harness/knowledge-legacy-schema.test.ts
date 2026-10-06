/**
 * 旧 knowledge.db（source_id/path 文件表）→ File identity schema 升级
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';

describe('knowledge.db legacy schema upgrade', () => {
  it('opens old (source_id,path) db without throwing tenant_id / identity errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-legacy-'));
    const dbPath = join(dir, 'knowledge.db');

    // 手工造 v1 旧 schema（无 identity_key / memberships / tenant_id 列）
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE knowledge_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        location TEXT NOT NULL,
        scope_level TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        sync_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        coverage REAL,
        errors_json TEXT NOT NULL DEFAULT '[]',
        display_name TEXT NOT NULL,
        description TEXT,
        generated_description TEXT,
        catalog_priority INTEGER,
        hidden_from_catalog INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE knowledge_projects (
        project_key TEXT PRIMARY KEY,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE knowledge_project_agents (
        project_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_key, agent_id)
      );
      CREATE TABLE knowledge_agent_hidden (
        agent_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, source_id)
      );
      CREATE TABLE knowledge_session_visibility (
        session_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        op TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, target_type, target_id)
      );
      CREATE TABLE knowledge_files (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL DEFAULT 0,
        adapter_id TEXT,
        status TEXT NOT NULL DEFAULT 'indexed',
        error TEXT,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL,
        UNIQUE (source_id, path)
      );
      CREATE TABLE knowledge_chunks (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        path TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        start_line INTEGER NOT NULL DEFAULT 1,
        end_line INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE knowledge_chunk_embeddings (
        chunk_id TEXT PRIMARY KEY,
        dimensions INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE knowledge_hits (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        chunk_id TEXT,
        path TEXT NOT NULL,
        agent_id TEXT,
        session_id TEXT,
        query TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'inject',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE knowledge_jobs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT,
        priority INTEGER NOT NULL DEFAULT 2,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // 造一条旧源 + 旧文件
    raw
      .prepare(
        `INSERT INTO knowledge_sources (id,kind,location,scope_level,scope_key,display_name,created_at,updated_at)
         VALUES ('src_old','directory','/tmp/x','global','global','old',1,1)`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO knowledge_files (id,source_id,path,content_hash,size,mtime,chunk_count,indexed_at)
         VALUES ('kf_old','src_old','a.md','h',3,1,1,1)`,
      )
      .run();
    raw.close();

    const db = await KnowledgeDatabase.create({ dbPath });
    try {
      const stats = db.stats();
      // 旧索引投影已重建为 0；源登记仍在
      expect(stats.sources).toBe(1);
      expect(stats.files).toBe(0);
      expect(stats.memberships).toBe(0);
      // 新列可写
      db.raw
        .prepare(
          `UPDATE knowledge_sources SET tenant_id='default', registered_by='gw1', visibility='private' WHERE id='src_old'`,
        )
        .run();
      const row = db.raw
        .prepare(`SELECT tenant_id, registered_by FROM knowledge_sources WHERE id='src_old'`)
        .get() as { tenant_id: string; registered_by: string };
      expect(row.tenant_id).toBe('default');
      expect(row.registered_by).toBe('gw1');
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
