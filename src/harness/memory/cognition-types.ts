/**
 * Cognition 类型定义
 *
 * @layer harness/memory — 认知图谱领域的类型和接口。
 */

/** 概念节点 */
export interface ConceptNode {
  id: string;
  name: string;
  description?: string;
  frequency: number;
  memoryIds: string[];
}

/** 概念关系 */
export interface ConceptEdge {
  sourceId: string;
  targetId: string;
  relationType: 'causes' | 'part_of' | 'opposes' | 'similar_to' | 'evolves_to' | 'related';
  strength: number;
  description?: string;
}

/** 认知图谱 */
export interface ConceptGraph {
  nodes: ConceptNode[];
  edges: ConceptEdge[];
}

/**
 * ConceptGraphStore — 认知图谱存储接口
 */
export interface ConceptGraphStore {
  addConcept(concept: Omit<ConceptNode, 'id' | 'frequency' | 'memoryIds'>): Promise<string>;
  addEdge(edge: ConceptEdge): Promise<void>;
  queryRelated(conceptName: string, depth?: number): Promise<ConceptGraph>;
  extractFromText(text: string, memoryId: string): Promise<void>;
  getFullGraph(): Promise<ConceptGraph>;
}

/**
 * ProjectMemory — 项目记忆接口
 */
export interface ProjectMemory {
  readonly root: string;
  load(): Promise<string>;
  append(content: string): Promise<void>;
  update(content: string): Promise<void>;
}
