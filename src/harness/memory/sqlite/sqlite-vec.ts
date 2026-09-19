/**
 * sqlite-vec 集成 — 可选原生向量索引
 *
 * 扩展未安装或加载失败时返回 false，调用方退回 JS 余弦路径。
 * 向量同时冗余写入 memories.embedding（JSON），便于审计与引擎切换。
 */

/** 记忆向量虚拟表名 */
export const MEMORY_VEC_TABLE = 'memory_vec';

function enableExtensionLoading(db: any): void {
  if (typeof db.enableLoadExtension !== 'function') return;
  try {
    db.enableLoadExtension(true);
  } catch {
    // 打开时未设 allowExtension —— 后续 loadExtension 会失败并走 catch
  }
}

/**
 * 尝试加载 sqlite-vec 扩展到 node:sqlite 连接。
 *
 * @param db - node:sqlite DatabaseSync
 * @param extensionPath - 可选显式扩展路径；默认使用 npm 包内置二进制
 * @returns 是否加载成功
 */
export async function tryLoadSqliteVec(db: any, extensionPath?: string): Promise<boolean> {
  if (!db) return false;
  try {
    if (extensionPath) {
      if (typeof db.loadExtension !== 'function') return false;
      enableExtensionLoading(db);
      db.loadExtension(extensionPath);
      return true;
    }
    const mod: any = await import('sqlite-vec');
    const sqliteVec = mod.default ?? mod;
    // node:sqlite 不兼容 better-sqlite3 风格的 sqliteVec.load(db)
    if (typeof sqliteVec?.getLoadablePath === 'function' && typeof db.loadExtension === 'function') {
      enableExtensionLoading(db);
      db.loadExtension(sqliteVec.getLoadablePath());
      return true;
    }
    return false;
  } catch {
    // 扩展未安装或 SQLite ABI 不匹配：调用方退回 JS 检索
    return false;
  }
}

/**
 * 确保记忆向量虚拟表存在且维度匹配。
 *
 * @returns 是否可用（维度冲突或建表失败时 false）
 */
export function ensureMemoryVecTable(db: any, dimensions: number): boolean {
  if (!db || !Number.isInteger(dimensions) || dimensions <= 0) return false;
  try {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(MEMORY_VEC_TABLE) as { sql?: string } | undefined;

    if (row?.sql) {
      const m = /float\[(\d+)\]/i.exec(row.sql);
      if (m && Number(m[1]) !== dimensions) {
        return false;
      }
      return true;
    }

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${MEMORY_VEC_TABLE} USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[${dimensions}] distance_metric=cosine
      );
    `);
    return true;
  } catch {
    return false;
  }
}

/** number[] → float32 blob（sqlite-vec MATCH 参数） */
export function toVecBlob(embedding: number[]): Buffer {
  const f32 = Float32Array.from(embedding);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** float32 blob → number[] */
export function fromVecBlob(buf: Buffer | Uint8Array | null | undefined): number[] | null {
  if (!buf) return null;
  const u8 = buf instanceof Buffer ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf;
  if (u8.byteLength % 4 !== 0) return null;
  const f32 = new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
  return Array.from(f32);
}

/** 写入/覆盖一条记忆向量 */
export function upsertMemoryVector(db: any, memoryId: string, embedding: number[]): void {
  db.prepare(`
    INSERT INTO ${MEMORY_VEC_TABLE} (memory_id, embedding)
    VALUES (?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET embedding = excluded.embedding
  `).run(memoryId, toVecBlob(embedding));
}

/** 删除记忆向量 */
export function deleteMemoryVector(db: any, memoryId: string): void {
  try {
    db.prepare(`DELETE FROM ${MEMORY_VEC_TABLE} WHERE memory_id = ?`).run(memoryId);
  } catch {
    // 表不存在时忽略
  }
}

export interface VecSearchHit {
  id: string;
  distance: number;
}

/**
 * KNN 检索记忆 id。
 *
 * @param extraWhere - 额外过滤（须以 AND 开头，列前缀 m.）
 * @param extraParams - extraWhere 参数
 */
export function searchMemoryVectors(
  db: any,
  queryVec: number[],
  k: number,
  extraWhere = '',
  extraParams: unknown[] = [],
): VecSearchHit[] {
  const kk = Math.max(1, Math.floor(k));
  const sql = `
    SELECT m.id AS id, v.distance AS distance
    FROM (
      SELECT memory_id, distance
      FROM ${MEMORY_VEC_TABLE}
      WHERE embedding MATCH ?
        AND k = ?
    ) v
    JOIN memories m ON m.id = v.memory_id
    WHERE 1=1 ${extraWhere}
    ORDER BY v.distance ASC
  `;
  try {
    const rows = db.prepare(sql).all(toVecBlob(queryVec), kk, ...extraParams) as Array<{
      id: string;
      distance: number;
    }>;
    return rows.map((r) => ({ id: String(r.id), distance: Number(r.distance) }));
  } catch {
    return [];
  }
}

/**
 * 同步 memories.embedding 列到 vec 表（单条）。
 */
export function syncMemoryVectorFromBlob(db: any, memoryId: string, embeddingJson: string | null): boolean {
  if (!embeddingJson) return false;
  try {
    const parsed = JSON.parse(embeddingJson) as number[];
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    upsertMemoryVector(db, memoryId, parsed);
    return true;
  } catch {
    return false;
  }
}
