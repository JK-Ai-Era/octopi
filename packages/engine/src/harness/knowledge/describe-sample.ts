/**
 * describe 抽样组装 — auto-describe 素材面（Tier 0）
 *
 * 素材组合（拍板 2026-11-02）：
 *   ① 源元数据 —— 经 `generateKnowledgeDescription` 的 source 参数单独传给端口，不进 sample；
 *   ② logical_path 前 20 条（结构辨识）；
 *   ③ 路径派生 topics（`deriveTopicsFromPaths`，与关键词索引同词面）；
 *   ④ 文件头 chunk（ordinal=0）抽样——唯一涉正文素材。
 *
 * 密钥形态扫描由调用边界把关：REST 出口（`describeSample`）与端口出口
 * （`generateKnowledgeDescription` 内部）各自扫描；本组装器不重复扫。
 */

import type { KnowledgeDatabase } from './db.js';
import { deriveTopicsFromPaths } from './topics.js';

/** 抽样总预算（字符）：paths + topics + 文件头共享 */
export const DESCRIBE_SAMPLE_MAX_CHARS = 4000;
/** ② 展示路径条数 */
const PATH_SAMPLE_LIMIT = 20;
/** ③ topics 统计的路径上限（词频稳定性，不追求全量） */
const TOPIC_PATH_LIMIT = 500;
/** ④ 文件头抽样的文件数 */
const HEAD_FILE_LIMIT = 8;
/** ④ 单文件头字符预算 */
const HEAD_PER_FILE_CHARS = 400;

/**
 * 组装 describe 抽样文本（②+③+④；① 由调用方单独携带）。
 *
 * @param db - knowledge.db 读句柄
 * @param sourceId - 源 id
 * @returns 抽样文本（≤ DESCRIBE_SAMPLE_MAX_CHARS；无内容时为空串）
 */
export function assembleDescribeSample(db: KnowledgeDatabase, sourceId: string): string {
  const pathRows = db.raw
    .prepare(
      'SELECT logical_path FROM knowledge_memberships WHERE source_id = ? ORDER BY logical_path LIMIT ?',
    )
    .all(sourceId, TOPIC_PATH_LIMIT) as Array<{ logical_path: string }>;
  const allPaths = pathRows.map((r) => r.logical_path);
  if (allPaths.length === 0) return '';

  const shownPaths = allPaths.slice(0, PATH_SAMPLE_LIMIT);
  const topics = deriveTopicsFromPaths(allPaths);

  const headRows = db.raw
    .prepare(
      `SELECT m.logical_path AS path, c.text AS text
         FROM knowledge_memberships m
         JOIN knowledge_chunks c ON c.file_id = m.file_id AND c.ordinal = 0
        WHERE m.source_id = ?
        ORDER BY m.logical_path
        LIMIT ?`,
    )
    .all(sourceId, HEAD_FILE_LIMIT) as Array<{ path: string; text: string }>;

  const parts: string[] = [];
  parts.push(
    `paths (${shownPaths.length} of ${allPaths.length}):\n${shownPaths.join('\n')}`,
  );
  if (topics.length > 0) {
    parts.push(`topics: ${topics.join(', ')}`);
  }
  if (headRows.length > 0) {
    const heads = headRows.map(
      (r) => `--- ${r.path}\n${r.text.slice(0, HEAD_PER_FILE_CHARS)}`,
    );
    parts.push(`file heads:\n${heads.join('\n')}`);
  }
  return parts.join('\n\n').slice(0, DESCRIBE_SAMPLE_MAX_CHARS);
}
