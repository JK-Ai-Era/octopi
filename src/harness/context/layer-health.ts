/**
 * 七层数据面健康探针（store 计数 / 注册状态）
 *
 * 供 Gateway REST 与 Web Context 面板展示「层背后的数据是否就绪」，
 * 与单轮 AssembleManifest（运行时命运）互补。
 */

import type {
  ConceptGraphStore,
  MemoryStore,
  WisdomStore,
} from '../memory/types.js';
import type { KnowledgeStore } from './knowledge/types.js';
import type { ContextLayerId } from './layer-types.js';
import { ALL_LAYER_IDS } from './layer-snapshot.js';

export interface ContextLayerHealthEntry {
  id: ContextLayerId;
  /** 本轮 build 路径是否注册了该层的数据源 */
  registered: boolean;
  /** 数据源条目数（节点/条目/技能数等）；未注册或不可测为 undefined */
  entries?: number;
  /** 附加读数（如 cognition edges） */
  extra?: Record<string, number>;
}

export interface ContextLayerHealth {
  agentId: string;
  /** 是否已 build 并接线 stores */
  configured: boolean;
  layers: ContextLayerHealthEntry[];
  /** 汇总计数，便于 UI 快速展示 */
  summary: {
    skills?: number;
    memory?: number;
    knowledge?: number;
    wisdom?: number;
    cognitionNodes?: number;
    cognitionEdges?: number;
    personaLoaded?: boolean;
  };
}

export interface ProbeContextHealthDeps {
  agentId: string;
  skillCount?: number;
  memoryStore?: MemoryStore;
  knowledgeStore?: KnowledgeStore;
  wisdomStore?: WisdomStore;
  cognitionStore?: ConceptGraphStore;
  personaLoaded?: boolean;
}

/**
 * 从 agent home 文件系统探测数据面健康（不依赖 Agent 是否已 build）
 *
 * @param agentId - Agent id
 * @param home - agent home 目录（persona / skills / agent.db）
 * @returns ContextLayerHealth
 */
export async function probeAgentHomeHealth(
  agentId: string,
  home: string,
): Promise<ContextLayerHealth> {
  const { existsSync } = await import('node:fs');
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');

  const skillDir = join(home, 'skills');
  let skillCount: number | undefined;
  if (existsSync(skillDir)) {
    try {
      const entries = readdirSync(skillDir, { withFileTypes: true });
      skillCount = entries.filter(
        (e) => e.isDirectory() && existsSync(join(skillDir, e.name, 'SKILL.md')),
      ).length;
    } catch {
      skillCount = undefined;
    }
  }

  const personaLoaded =
    existsSync(join(home, 'AGENTS.md')) ||
    existsSync(join(home, 'persona')) ||
    existsSync(join(home, 'persona.md'));

  let memoryStore: MemoryStore | undefined;
  let wisdomStore: WisdomStore | undefined;
  let cognitionStore: ConceptGraphStore | undefined;
  const dbPath = join(home, 'agent.db');
  if (existsSync(dbPath)) {
    try {
      const { AgentDatabase } = await import('../memory/sqlite/agent-db.js');
      const { SqliteMemoryStore } = await import('../memory/sqlite/memory-store.js');
      const { SqliteWisdomStore } = await import('../memory/sqlite/wisdom-store.js');
      const { SqliteConceptGraph } = await import('../memory/sqlite/cognition-store.js');
      const db = await AgentDatabase.create({ dbPath });
      memoryStore = new SqliteMemoryStore(db);
      wisdomStore = new SqliteWisdomStore(db);
      cognitionStore = new SqliteConceptGraph(db);
    } catch {
      // sqlite 不可用时仍返回 skills/persona 探测结果
    }
  }

  return probeContextLayerHealth({
    agentId,
    skillCount,
    memoryStore,
    wisdomStore,
    cognitionStore,
    personaLoaded,
  });
}

/**
 * 探测各层数据源健康度
 *
 * @param deps - build 时持有的 store / skill 计数 / persona 状态
 * @returns ContextLayerHealth
 */
export async function probeContextLayerHealth(
  deps: ProbeContextHealthDeps,
): Promise<ContextLayerHealth> {
  const summary: ContextLayerHealth['summary'] = {
    skills: deps.skillCount,
    personaLoaded: deps.personaLoaded,
  };

  let memoryEntries: number | undefined;
  if (deps.memoryStore) {
    try {
      const stats = await deps.memoryStore.stats();
      memoryEntries = stats.totalEntries;
      summary.memory = memoryEntries;
    } catch {
      memoryEntries = undefined;
    }
  }

  let knowledgeEntries: number | undefined;
  if (deps.knowledgeStore) {
    try {
      // KnowledgeStore 契约暂无 stats；retrieve 空 query 不可靠，跳过精确计数
      knowledgeEntries = undefined;
    } catch {
      knowledgeEntries = undefined;
    }
  }

  let wisdomEntries: number | undefined;
  if (deps.wisdomStore) {
    try {
      const all = await deps.wisdomStore.getAll();
      wisdomEntries = all.length;
      summary.wisdom = wisdomEntries;
    } catch {
      wisdomEntries = undefined;
    }
  }

  let cognitionNodes: number | undefined;
  let cognitionEdges: number | undefined;
  if (deps.cognitionStore) {
    try {
      const graph = await deps.cognitionStore.getFullGraph();
      cognitionNodes = graph.nodes.length;
      cognitionEdges = graph.edges.length;
      summary.cognitionNodes = cognitionNodes;
      summary.cognitionEdges = cognitionEdges;
    } catch {
      cognitionNodes = undefined;
    }
  }

  const registeredMap: Partial<Record<ContextLayerId, boolean>> = {
    persona: deps.personaLoaded !== false,
    // skill 目录存在即视为已接线（count 可为 0）
    skill: deps.skillCount !== undefined,
    knowledge: Boolean(deps.knowledgeStore),
    memory: Boolean(deps.memoryStore),
    wisdom: Boolean(deps.wisdomStore),
    cognition: Boolean(deps.cognitionStore),
    runtime: true,
  };

  const entriesMap: Partial<Record<ContextLayerId, number | undefined>> = {
    skill: deps.skillCount,
    knowledge: knowledgeEntries,
    memory: memoryEntries,
    wisdom: wisdomEntries,
    cognition: cognitionNodes,
  };

  const layers: ContextLayerHealthEntry[] = ALL_LAYER_IDS.map((id) => {
    const registered = registeredMap[id] ?? false;
    return {
      id,
      registered,
      entries: entriesMap[id],
      ...(id === 'cognition' && cognitionEdges !== undefined
        ? { extra: { edges: cognitionEdges } }
        : {}),
    };
  });

  return {
    agentId: deps.agentId,
    configured:
      Boolean(deps.memoryStore) ||
      Boolean(deps.wisdomStore) ||
      Boolean(deps.cognitionStore) ||
      Boolean(deps.knowledgeStore) ||
      deps.skillCount !== undefined ||
      Boolean(deps.personaLoaded),
    layers,
    summary,
  };
}
