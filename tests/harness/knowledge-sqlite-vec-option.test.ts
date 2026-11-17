/**
 * A12 — vectorEngine 显式化：单源换算 + 统一降级语义（require 拒启 / auto 显式告警 / js 不加载）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  loadSqliteVecOrDegrade,
  sqliteVecOption,
} from '@octopi-agent/engine/harness/memory/sqlite/sqlite-vec.js';

/** 模拟 node:sqlite 连接契约：enableLoadExtension 存在；loadExtension 对不存在路径抛错（真库同形） */
const failingDb = {
  enableLoadExtension(): void {},
  loadExtension(): void {
    throw new Error('no such extension');
  },
};

describe('sqliteVecOption', () => {
  it('js=不加载；sqlite-vec=必须加载；auto/缺省=尝试', () => {
    expect(sqliteVecOption('js')).toBe(false);
    expect(sqliteVecOption('sqlite-vec', '/x/vec.so')).toEqual({
      extensionPath: '/x/vec.so',
      require: true,
    });
    expect(sqliteVecOption('sqlite-vec')).toEqual({ require: true });
    expect(sqliteVecOption('auto')).toEqual({ require: false });
    expect(sqliteVecOption()).toEqual({ require: false });
  });
});

describe('loadSqliteVecOrDegrade', () => {
  it('false / undefined → 不加载不告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadSqliteVecOrDegrade(failingDb, false, 'knowledge.db')).toBe(false);
    expect(await loadSqliteVecOrDegrade(failingDb, undefined, 'knowledge.db')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('require 档加载失败 → sqlite_vec_load_failed（fail-loud）', async () => {
    await expect(
      loadSqliteVecOrDegrade(failingDb, { extensionPath: '/nope', require: true }, 'knowledge.db'),
    ).rejects.toThrow(/sqlite_vec_load_failed/);
  });

  it('auto 档加载失败 → 回退 JS 且显式告警（不静默）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadSqliteVecOrDegrade(failingDb, { extensionPath: '/nope' }, 'knowledge.db')).toBe(
      false,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('knowledge.db');
    warn.mockRestore();
  });

  it('端到端：KnowledgeDatabase.create 显式档加载失败拒启（真库真选项）', async () => {
    const { KnowledgeDatabase } = await import(
      '../../packages/engine/src/harness/knowledge/db.js'
    );
    await expect(
      KnowledgeDatabase.create({
        dbPath: ':memory:',
        sqliteVec: { extensionPath: '/definitely/not/here', require: true },
      }),
    ).rejects.toThrow(/sqlite_vec_load_failed/);
  });

  it('端到端：js 档不加载扩展（sqliteVecEnabled=false）', async () => {
    const { KnowledgeDatabase } = await import(
      '../../packages/engine/src/harness/knowledge/db.js'
    );
    const db = await KnowledgeDatabase.create({ dbPath: ':memory:', sqliteVec: false });
    expect(db.sqliteVecEnabled).toBe(false);
    db.close();
  });
});

describe('缺省语义锁（M5：本次事故回归点）', () => {
  it('KnowledgeDatabase 缺省=尝试加载；AgentDatabase 缺省=不加载', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { tryLoadSqliteVec } = await import(
      '@octopi-agent/engine/harness/memory/sqlite/sqlite-vec.js'
    );
    const { KnowledgeDatabase } = await import(
      '../../packages/engine/src/harness/knowledge/db.js'
    );
    const { AgentDatabase } = await import(
      '../../packages/engine/src/harness/memory/sqlite/agent-db.js'
    );
    // 独立探针：本机扩展是否可用（决定缺省尝试的期望值）；
    // allowExtension 必须开库时声明（node:sqlite 限制），与 KnowledgeDatabase 构造同条件
    const probe = new DatabaseSync(':memory:', { allowExtension: true });
    const available = await tryLoadSqliteVec(probe, undefined);

    const kdb = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    expect(kdb.sqliteVecEnabled).toBe(available); // 缺省必须「尝试」：扩展可用即加载
    kdb.close();

    const adb = await AgentDatabase.create({ dbPath: ':memory:' });
    expect(adb.sqliteVecEnabled).toBe(false); // 缺省必须「不加载」
    adb.close();
  });
});
