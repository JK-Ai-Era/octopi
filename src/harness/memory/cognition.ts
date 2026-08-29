/**
 * InMemoryConceptGraph — 内存认知图谱
 *
 * P0 基础版：基于关键词的简单概念提取和关系建立。
 * P1 增强版：LLM 驱动的深度概念提取。
 */

import { randomUUID } from 'node:crypto';
import type {
  ConceptGraphStore,
  ConceptNode,
  ConceptEdge,
  ConceptGraph,
} from '../../core/interfaces/memory.js';

export class InMemoryConceptGraph implements ConceptGraphStore {
  private nodes = new Map<string, ConceptNode>();
  private edges: ConceptEdge[] = [];

  async addConcept(concept: Omit<ConceptNode, 'id' | 'frequency' | 'memoryIds'>): Promise<string> {
    // 检查是否已存在同名概念
    for (const [id, node] of this.nodes) {
      if (node.name.toLowerCase() === concept.name.toLowerCase()) {
        node.frequency++;
        return id;
      }
    }
    const id = randomUUID().slice(0, 8);
    this.nodes.set(id, { ...concept, id, frequency: 1, memoryIds: [] });
    return id;
  }

  async addEdge(edge: ConceptEdge): Promise<void> {
    // 避免重复边
    const exists = this.edges.some(e =>
      e.sourceId === edge.sourceId && e.targetId === edge.targetId && e.relationType === edge.relationType
    );
    if (!exists) {
      this.edges.push(edge);
    }
  }

  async queryRelated(conceptName: string, depth = 1): Promise<ConceptGraph> {
    const relatedNodes = new Map<string, ConceptNode>();
    const relatedEdges: ConceptEdge[] = [];

    // 找到起始概念
    let startId: string | null = null;
    for (const [id, node] of this.nodes) {
      if (node.name.toLowerCase().includes(conceptName.toLowerCase())) {
        startId = id;
        relatedNodes.set(id, node);
        break;
      }
    }

    if (!startId) return { nodes: [], edges: [] };

    // BFS 查找相关概念
    const queue = [{ id: startId, currentDepth: 0 }];
    const visited = new Set<string>([startId]);

    while (queue.length > 0) {
      const { id, currentDepth } = queue.shift()!;
      if (currentDepth >= depth) continue;

      for (const edge of this.edges) {
        let neighborId: string | null = null;
        if (edge.sourceId === id) neighborId = edge.targetId;
        else if (edge.targetId === id) neighborId = edge.sourceId;

        if (neighborId && !visited.has(neighborId)) {
          visited.add(neighborId);
          const node = this.nodes.get(neighborId);
          if (node) {
            relatedNodes.set(neighborId, node);
            relatedEdges.push(edge);
            queue.push({ id: neighborId, currentDepth: currentDepth + 1 });
          }
        }
      }
    }

    return {
      nodes: Array.from(relatedNodes.values()),
      edges: relatedEdges,
    };
  }

  async extractFromText(text: string, memoryId: string): Promise<void> {
    // P0 基础版：简单关键词提取
    // 提取大写开头的词作为概念候选
    const conceptPattern = /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g;
    const matches = text.match(conceptPattern) ?? [];

    const conceptIds: string[] = [];
    for (const match of new Set(matches)) {
      if (match.length < 3 || match.length > 50) continue;
      const id = await this.addConcept({ name: match });
      const node = this.nodes.get(id);
      if (node && !node.memoryIds.includes(memoryId)) {
        node.memoryIds.push(memoryId);
      }
      conceptIds.push(id);
    }

    // 建立共现关系（同一文本中出现的概念之间）
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
    return {
      nodes: Array.from(this.nodes.values()),
      edges: [...this.edges],
    };
  }
}
