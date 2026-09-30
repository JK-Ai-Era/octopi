/**
 * SqliteConceptGraph — SQLite 认知图谱
 *
 * @module
 */

import type {
  ConceptGraphStore,
  ConceptNode,
  ConceptEdge,
  ConceptGraph,
} from '../cognition-types.js';
import { AgentDatabase } from './agent-db.js';
import type { EmbeddingProvider } from './embedding.js';
import { cosineDistance, parseEmbedding, serializeEmbedding } from './vector-search.js';

export interface SqliteConceptGraphOptions {
  embeddingProvider?: EmbeddingProvider | null;
  /** 自动合并的 cosine distance 阈值（默认 0.25） */
  mergeThreshold?: number;
}

export class SqliteConceptGraph implements ConceptGraphStore {
  private db: AgentDatabase;
  private embedding: EmbeddingProvider | null;
  private mergeThreshold: number;

  constructor(db: AgentDatabase, options?: SqliteConceptGraphOptions) {
    this.db = db;
    this.embedding = options?.embeddingProvider ?? null;
    this.mergeThreshold = options?.mergeThreshold ?? 0.25;
  }

  async addConcept(concept: Omit<ConceptNode, 'id' | 'frequency' | 'memoryIds'>): Promise<string> {
    // 1. 精确匹配
    const existing = this.db.raw.prepare(
      'SELECT id, frequency FROM concepts WHERE LOWER(name) = LOWER(?)'
    ).get(concept.name) as { id: string; frequency: number } | undefined;

    if (existing) {
      this.db.raw.prepare(
        'UPDATE concepts SET frequency = frequency + 1, updated_at = ? WHERE id = ?'
      ).run(Date.now(), existing.id);
      return existing.id;
    }

    // 2. 语义匹配（需要 embedding）
    if (this.embedding) {
      const vec = await this.embedding.embed(concept.name);
      const similarId = await this.findSimilarConcept(vec);
      if (similarId) {
        // 合并：更新 frequency
        this.db.raw.prepare(
          'UPDATE concepts SET frequency = frequency + 1, updated_at = ? WHERE id = ?'
        ).run(Date.now(), similarId);
        return similarId;
      }

      // 新概念（带 embedding）
      const id = AgentDatabase.generateId('cpt');
      const now = Date.now();
      this.db.raw.prepare(`
        INSERT INTO concepts (id, name, description, frequency, memory_ids, properties, embedding, created_at, updated_at)
        VALUES (?, ?, ?, 1, '[]', '[]', ?, ?, ?)
      `).run(id, concept.name, concept.description ?? null, serializeEmbedding(vec), now, now);
      return id;
    }

    // 新概念（无 embedding）
    const id = AgentDatabase.generateId('cpt');
    const now = Date.now();
    this.db.raw.prepare(`
      INSERT INTO concepts (id, name, description, frequency, memory_ids, properties, embedding, created_at, updated_at)
      VALUES (?, ?, ?, 1, '[]', '[]', NULL, ?, ?)
    `).run(id, concept.name, concept.description ?? null, now, now);
    return id;
  }

  async addEdge(edge: ConceptEdge): Promise<void> {
    const id = AgentDatabase.generateId('edge');
    this.db.raw.prepare(`
      INSERT OR IGNORE INTO concept_edges (id, source_id, target_id, relation_type, strength, description, constraints, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      edge.sourceId,
      edge.targetId,
      edge.relationType,
      edge.strength,
      edge.description ?? null,
      JSON.stringify([]),
      Date.now(),
    );
  }

  async queryRelated(conceptName: string, depth = 1): Promise<ConceptGraph> {
    // 找到起始概念
    const start = this.db.raw.prepare(
      'SELECT id FROM concepts WHERE LOWER(name) LIKE LOWER(?)'
    ).get(`%${conceptName}%`) as { id: string } | undefined;

    if (!start) return { nodes: [], edges: [] };

    // 递归 CTE 图遍历
    const rows = this.db.raw.prepare(`
      WITH RECURSIVE graph_walk(node_id, depth) AS (
        SELECT ?, 0
        UNION
        SELECT DISTINCT
          CASE WHEN e.source_id = gw.node_id THEN e.target_id ELSE e.source_id END,
          gw.depth + 1
        FROM graph_walk gw
        JOIN concept_edges e ON (e.source_id = gw.node_id OR e.target_id = gw.node_id)
        WHERE gw.depth < ?
      )
      SELECT DISTINCT c.*, gw.depth
      FROM graph_walk gw
      JOIN concepts c ON c.id = gw.node_id
      ORDER BY gw.depth, c.frequency DESC
      LIMIT 20
    `).all(start.id, depth) as any[];

    const nodes = rows.map(r => this.rowToNode(r));
    const nodeIds = new Set(nodes.map(n => n.id));

    // 获取相关的边
    const allEdges = this.db.raw.prepare(`
      SELECT * FROM concept_edges
      WHERE source_id IN (${nodes.map(() => '?').join(',')})
         OR target_id IN (${nodes.map(() => '?').join(',')})
    `).all(...nodeIds, ...nodeIds) as any[];

    const edges = allEdges
      .filter((e: any) => nodeIds.has(e.source_id) && nodeIds.has(e.target_id))
      .map((e: any) => this.rowToEdge(e));

    return { nodes, edges };
  }

  async extractFromText(text: string, memoryId: string): Promise<void> {
    // P0 简单实现：正则提取大写开头的词 + 共现分析
    const conceptPattern = /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g;
    const matches = text.match(conceptPattern) ?? [];

    const conceptIds: string[] = [];
    for (const match of new Set(matches)) {
      if (match.length < 3 || match.length > 50) continue;
      const id = await this.addConcept({ name: match });

      // 关联记忆
      const row = this.db.raw.prepare('SELECT memory_ids FROM concepts WHERE id = ?').get(id) as { memory_ids: string } | undefined;
      if (row) {
        const memoryIds: string[] = JSON.parse(row.memory_ids);
        if (!memoryIds.includes(memoryId)) {
          memoryIds.push(memoryId);
          this.db.raw.prepare('UPDATE concepts SET memory_ids = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(memoryIds), Date.now(), id);
        }
      }

      conceptIds.push(id);
    }

    // 共现关系
    for (let i = 0; i < conceptIds.length; i++) {
      for (let j = i + 1; j < conceptIds.length; j++) {
        await this.addEdge({
          sourceId: conceptIds[i],
          targetId: conceptIds[j],
          relationType: 'related',
          strength: 0.5,
        });
      }
    }
  }

  async getFullGraph(): Promise<ConceptGraph> {
    const nodes = (this.db.raw.prepare('SELECT * FROM concepts').all() as any[])
      .map(r => this.rowToNode(r));
    const edges = (this.db.raw.prepare('SELECT * FROM concept_edges').all() as any[])
      .map(r => this.rowToEdge(r));
    return { nodes, edges };
  }

  /**
   * 查找语义相似的概念（用于去重）
   */
  private async findSimilarConcept(embedding: number[]): Promise<string | null> {
    const rows = this.db.raw.prepare(
      'SELECT id, embedding FROM concepts WHERE embedding IS NOT NULL'
    ).all() as Array<{ id: string; embedding: string }>;

    let bestId: string | null = null;
    let bestDistance = Infinity;

    for (const row of rows) {
      const vec = parseEmbedding(row.embedding);
      if (!vec) continue;
      const distance = cosineDistance(embedding, vec);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = row.id;
      }
    }

    if (bestDistance <= this.mergeThreshold) {
      return bestId;
    }
    return null;
  }

  /**
   * 关联记忆到概念（从外部调用）
   */
  linkMemory(conceptId: string, memoryId: string): void {
    const row = this.db.raw.prepare('SELECT memory_ids FROM concepts WHERE id = ?').get(conceptId) as { memory_ids: string } | undefined;
    if (!row) return;

    const memoryIds: string[] = JSON.parse(row.memory_ids);
    if (!memoryIds.includes(memoryId)) {
      memoryIds.push(memoryId);
      this.db.raw.prepare('UPDATE concepts SET memory_ids = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(memoryIds), Date.now(), conceptId);
    }
  }

  private rowToNode(row: any): ConceptNode {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      frequency: row.frequency,
      memoryIds: JSON.parse(row.memory_ids),
    };
  }

  private rowToEdge(row: any): ConceptEdge {
    return {
      sourceId: row.source_id,
      targetId: row.target_id,
      relationType: row.relation_type,
      strength: row.strength,
      description: row.description ?? undefined,
    };
  }
}
