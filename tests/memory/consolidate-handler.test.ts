/**
 * cognition.steward.consolidate handler — merge_llm_adjudication（B2）
 *
 * kind≠ / embedding_band（含 strong_near）候选交 LLM 裁决 merge/keep_split/drop：
 * 合并执行走 resolveMerge（canonicalKind 落置）、限流 ≤10/批、悬空候选作废、
 * 解析失败 fail-loud、信号计数。
 */

import { describe, it, expect } from 'vitest';
import consolidateHandler from '@octopi-agent/engine/subsystems/cognition-steward/consolidate/handler.js';
import {
  AgentDatabase,
  InMemoryConceptGraph,
  InMemoryMemoryStore,
  SqliteConceptGraph,
} from '@octopi-agent/engine/harness/memory/index.js';
import type {
  ConceptGraphStore,
  MemoryEntry,
} from '@octopi-agent/engine/harness/memory/types.js';
import type { EmbeddingProvider } from '@octopi-agent/engine/harness/memory/sqlite/embedding.js';
import {
  DEP_LLM_PORT,
  type SubsystemLLMPort,
  type SubsystemLLMPortChatRequest,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/think/llm-port.js';

const DEP_CONCEPT_GRAPH_KEY = 'conceptGraphStore';
const DEP_MEMORY_STORE_KEY = 'memoryStore';

function mockLlm(
  respond: (request: SubsystemLLMPortChatRequest) => string,
  requests: SubsystemLLMPortChatRequest[] = [],
): SubsystemLLMPort {
  return {
    cognitivePrompt: '',
    defaultModel: 'mini',
    providerName: 'mock',
    resolved: { primary: { model: 'mini' }, fallback: [] },
    chat: async (request: SubsystemLLMPortChatRequest) => {
      requests.push(request);
      return { content: respond(request), model: 'mini', finishReason: 'stop' };
    },
  } as unknown as SubsystemLLMPort;
}

function memoryEntry(id: string, content: string): MemoryEntry {
  return {
    id,
    type: 'fact',
    content,
    source: 'test',
    confidence: 0.9,
    importance: 0.5,
    accessCount: 0,
    lastAccessedAt: 0,
    createdAt: 1,
    decayFactor: 1,
    tags: [],
  };
}

async function memoryStoreWith(...entries: Array<[string, string]>): Promise<InMemoryMemoryStore> {
  const ms = new InMemoryMemoryStore();
  for (const [id, content] of entries) {
    await ms.importEntry(memoryEntry(id, content));
  }
  return ms;
}

function dossierCandidateIds(request: SubsystemLLMPortChatRequest): string[] {
  const text = String((request.messages[0] as { content?: unknown })?.content ?? '');
  const parsed = JSON.parse(text) as { candidates: Array<{ candidateId: string }> };
  return parsed.candidates.map((c) => c.candidateId);
}

function decideAll(action: 'merge' | 'keep_split' | 'drop') {
  return (request: SubsystemLLMPortChatRequest): string => {
    const decisions = dossierCandidateIds(request).map((candidateId) => ({
      candidateId,
      action,
      reason: 'test',
    }));
    return JSON.stringify({ decisions });
  };
}

describe('consolidate merge_llm_adjudication', () => {
  it('kind≠ 对经裁决 merge：合并执行 + canonicalKind 落置 + 计数', async () => {
    const store = new InMemoryConceptGraph();
    await store.admitConcept({
      name: '上下文切片锚定',
      kind: 'construct',
      memoryIds: ['m1'],
      supportCount: 2,
    });
    const right = await store.admitConcept({
      name: '上下文切片锚定',
      kind: 'method',
      description: '方法侧描述',
      memoryIds: ['m2'],
      supportCount: 2,
    });
    expect(right.action).toBe('merge_candidate');

    const requests: SubsystemLLMPortChatRequest[] = [];
    const out = await consolidateHandler(
      { payload: {} } as never,
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_MEMORY_STORE_KEY]: await memoryStoreWith(
          ['m1', 'construct 侧命题'],
          ['m2', 'method 侧命题'],
        ),
        [DEP_LLM_PORT]: mockLlm(
          () =>
            JSON.stringify({
              decisions: [
                { candidateId: right.candidateId, action: 'merge', canonicalKind: 'method', reason: '同名变体' },
              ],
            }),
          requests,
        ),
      },
    );

    expect(out.act.status).toBe('success');
    const graph = await store.getFullGraph();
    expect(graph.nodes).toHaveLength(1);
    // canonicalKind 生效：幸存行 kind 从 construct 变 method；description 空侧吸收
    expect(graph.nodes[0]!.kind).toBe('method');
    expect(graph.nodes[0]!.description).toBe('方法侧描述');
    const data = out.signals[0]!.data as { adjudication: Record<string, number> };
    expect(data.adjudication.merged).toBe(1);
    expect(await store.listMergeCandidates()).toHaveLength(0);
  });

  it('embedding_band 对按裁决 keep_split / drop 分别计数', async () => {
    const db = await AgentDatabase.create({ dbPath: ':memory:' });
    const fixed: EmbeddingProvider = {
      name: 'fixed',
      dimensions: 2,
      embed: async (t: string) => {
        const table: Record<string, number[]> = { 锚定验证: [1, 0], 验证锚定: [5, 1] };
        const v = table[t];
        if (!v) throw new Error(`no vector for ${t}`);
        return v;
      },
      embedBatch: async (texts: string[]) => Promise.all(texts.map((t) => fixed.embed(t))),
    };
    const store = new SqliteConceptGraph(db, { embeddingProvider: fixed });
    await store.admitConcept({ name: '锚定验证', kind: 'construct', supportCount: 2 });
    const near = await store.admitConcept({ name: '验证锚定', kind: 'construct', supportCount: 2 });
    expect(near.action).toBe('merge_candidate');

    const requests: SubsystemLLMPortChatRequest[] = [];
    const out = await consolidateHandler(
      { payload: {} } as never,
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_MEMORY_STORE_KEY]: await memoryStoreWith(),
        [DEP_LLM_PORT]: mockLlm(
          () =>
            JSON.stringify({
              decisions: [{ candidateId: near.candidateId, action: 'keep_split', reason: '两个概念' }],
            }),
          requests,
        ),
      },
    );
    expect(out.act.status).toBe('success');
    const data = out.signals[0]!.data as { adjudication: Record<string, number> };
    expect(data.adjudication.keptSplit).toBe(1);
    const rows = (await store.listMergeCandidates()).filter((c) => c.id === near.candidateId);
    expect(rows).toHaveLength(0); // keep_split 后候选出池
    // strong_near 标注进入档案（喂裁决优先级）
    expect(String((requests[0]!.messages[0] as { content: string }).content)).toContain('"strongNear":true');
    db.close();
  });

  it('限流：超过 adjudicateMaxBatch 的候选留池（unresolved 计数）', async () => {
    const store = new InMemoryConceptGraph();
    for (let i = 0; i < 6; i += 1) {
      await store.admitConcept({ name: `P${i}`, kind: 'construct', supportCount: 2 });
      await store.admitConcept({ name: `P${i}`, kind: 'entity', supportCount: 2 });
    }
    expect(await store.listMergeCandidates()).toHaveLength(6);
    // 6 个 kind≠ 候选 + 用 embedding_band 达不到 12——改以 batch=3 限流验证
    const requests: SubsystemLLMPortChatRequest[] = [];
    const out = await consolidateHandler(
      { payload: {} } as never,
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_MEMORY_STORE_KEY]: await memoryStoreWith(),
        [DEP_LLM_PORT]: mockLlm(decideAll('keep_split'), requests),
        __subsystem_config__: { adjudicateMaxBatch: 3 },
      } as never,
    );
    expect(requests).toHaveLength(1);
    expect(dossierCandidateIds(requests[0]!)).toHaveLength(3);
    const data = out.signals[0]!.data as { adjudication: Record<string, number> };
    expect(data.adjudication.batch).toBe(3);
    expect(data.adjudication.keptSplit).toBe(3);
    expect(data.adjudication.unresolved).toBe(3);
    expect(await store.listMergeCandidates()).toHaveLength(3); // 其余留池
  });

  it('解析失败 fail-loud：act.status=failed 但确定性巩固照常执行', async () => {
    const store = new InMemoryConceptGraph();
    await store.admitConcept({ name: '甲概念', kind: 'construct', supportCount: 2 });
    await store.admitConcept({ name: '甲概念', kind: 'entity', supportCount: 2 });
    const requests: SubsystemLLMPortChatRequest[] = [];
    const out = await consolidateHandler(
      { payload: {} } as never,
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_MEMORY_STORE_KEY]: await memoryStoreWith(),
        [DEP_LLM_PORT]: mockLlm(() => '这不是 JSON', requests),
      },
    );
    expect(out.act.status).toBe('failed'); // fail-loud
    expect(requests.length).toBeGreaterThanOrEqual(2); // completion-guard 完整性重试后仍失败
    expect(await store.listMergeCandidates()).toHaveLength(1); // 候选未被误动
    // 显式降级：decay/promote/capacity 不被 LLM 故障吞掉
    expect(String(out.act.messages?.[0]?.content ?? '')).toContain('decayed=');
    expect(out.signals.some((s) => s.action === 'alert')).toBe(true);
  });

  it('llmPort 缺失且有可裁决候选 → failed + alert，确定性步骤照常', async () => {
    const store = new InMemoryConceptGraph();
    await store.admitConcept({ name: '乙概念', kind: 'construct', supportCount: 2 });
    await store.admitConcept({ name: '乙概念', kind: 'entity', supportCount: 2 });
    const out = await consolidateHandler(
      { payload: {} } as never,
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_MEMORY_STORE_KEY]: await memoryStoreWith(),
      },
    );
    expect(out.act.status).toBe('failed');
    expect(String(out.act.error)).toContain('llmPort');
    expect(out.signals.some((s) => s.action === 'alert')).toBe(true);
    expect(String(out.act.messages?.[0]?.content ?? '')).toContain('decayed=');
  });

  it('无可裁决候选时不烧 LLM，照常完成', async () => {
    const store = new InMemoryConceptGraph();
    const requests: SubsystemLLMPortChatRequest[] = [];
    const out = await consolidateHandler(
      { payload: {} } as never,
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_MEMORY_STORE_KEY]: await memoryStoreWith(),
        [DEP_LLM_PORT]: mockLlm(decideAll('drop'), requests),
      },
    );
    expect(out.act.status).toBe('success');
    expect(requests).toHaveLength(0);
  });

  it('kind≠ merge 缺有效 canonicalKind → 降级 keep_split（不静默按左侧行 kind 合并）', async () => {
    const store: ConceptGraphStore = new InMemoryConceptGraph();
    await store.admitConcept({ name: '丙概念', kind: 'construct', memoryIds: ['m1'], supportCount: 2 });
    const right = await store.admitConcept({ name: '丙概念', kind: 'entity', memoryIds: ['m2'], supportCount: 2 });
    const out = await consolidateHandler(
      { payload: {} } as never,
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_MEMORY_STORE_KEY]: await memoryStoreWith(['m1', '命题一'], ['m2', '命题二']),
        [DEP_LLM_PORT]: mockLlm(() =>
          JSON.stringify({
            decisions: [
              { candidateId: right.candidateId, action: 'merge', canonicalKind: 'banana', reason: 'x' },
            ],
          }),
        ),
      },
    );
    expect(out.act.status).toBe('success');
    const graph = await store.getFullGraph();
    expect(graph.nodes).toHaveLength(2); // 未合并
    expect(graph.nodes.map((n) => n.kind).sort()).toEqual(['construct', 'entity']);
    const data = out.signals[0]!.data as { adjudication: Record<string, number> };
    expect(data.adjudication.canonicalKindMissing).toBe(1);
    expect(data.adjudication.keptSplit).toBe(1);
    expect(data.adjudication.merged).toBe(0);
  });

  it('LLM 漏答的候选计 unresolved 且留池', async () => {
    const store = new InMemoryConceptGraph();
    await store.admitConcept({ name: '丁概念', kind: 'construct', supportCount: 2 });
    const right = await store.admitConcept({ name: '丁概念', kind: 'entity', supportCount: 2 });
    const out = await consolidateHandler(
      { payload: {} } as never,
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_MEMORY_STORE_KEY]: await memoryStoreWith(),
        [DEP_LLM_PORT]: mockLlm(() =>
          JSON.stringify({
            decisions: [{ candidateId: 'mrg_不存在的幻觉id', action: 'keep_split', reason: 'x' }],
          }),
        ),
      },
    );
    expect(out.act.status).toBe('success');
    const data = out.signals[0]!.data as { adjudication: Record<string, number> };
    expect(data.adjudication.unresolved).toBe(1);
    expect(await store.listMergeCandidates()).toHaveLength(1); // 留池
    expect(right.candidateId).toBeTruthy();
  });

  it('同名同 kind 的 legacy 候选免 LLM 确定性合并（B1 身份规则）', async () => {
    const db = await AgentDatabase.create({ dbPath: ':memory:' });
    const store = new SqliteConceptGraph(db);
    const a = await store.admitConcept({ name: '重复概念', kind: 'method', memoryIds: ['m1'], supportCount: 2 });
    // 模拟 B1 前遗留的拆行对：同名同 kind 双行 + domain_disjoint 候选
    const bId = 'cpt_legacy_b';
    db.raw
      .prepare(
        'INSERT INTO concepts (id, name, kind, description, memory_ids, domain, frequency, status, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?, ?)',
      )
      .run(bId, '重复概念', 'method', JSON.stringify(['m2']), JSON.stringify(['x']), 'shadow', 1, 2);
    db.raw
      .prepare(
        'INSERT INTO concept_merge_candidates (id, left_id, right_id, reason, distance, fingerprint_diff, status, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
      )
      .run('mrg_legacy_1', a.id!, bId, 'domain_disjoint', JSON.stringify([]), 'open', 3);

    const requests: SubsystemLLMPortChatRequest[] = [];
    const out = await consolidateHandler(
      { payload: {} } as never,
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_MEMORY_STORE_KEY]: await memoryStoreWith(),
        [DEP_LLM_PORT]: mockLlm(decideAll('keep_split'), requests),
      },
    );
    expect(out.act.status).toBe('success');
    expect(requests).toHaveLength(0); // 免 LLM
    const data = out.signals[0]!.data as { adjudication: Record<string, number> };
    expect(data.adjudication.autoMerged).toBe(1);
    expect((await store.getFullGraph()).nodes).toHaveLength(1); // 双行并一
    db.close();
  });

  it('跨名候选不论 reason 都交 LLM（不被 legacy 字符串路由吞掉）', async () => {
    const db = await AgentDatabase.create({ dbPath: ':memory:' });
    const store = new SqliteConceptGraph(db);
    const a = await store.admitConcept({ name: '甲名', kind: 'method', supportCount: 2 });
    const b = await store.admitConcept({ name: '乙名', kind: 'method', supportCount: 2 });
    // 模拟历史 reason：跨名近邻对在 B1 前会被 domain_disjoint 记账
    db.raw
      .prepare(
        'INSERT INTO concept_merge_candidates (id, left_id, right_id, reason, distance, fingerprint_diff, status, created_at) VALUES (?, ?, ?, ?, 0.32, ?, ?, ?)',
      )
      .run('mrg_legacy_2', a.id!, b.id!, 'domain_disjoint', JSON.stringify([]), 'open', 3);

    const requests: SubsystemLLMPortChatRequest[] = [];
    const out = await consolidateHandler(
      { payload: {} } as never,
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_MEMORY_STORE_KEY]: await memoryStoreWith(),
        [DEP_LLM_PORT]: mockLlm(decideAll('keep_split'), requests),
      },
    );
    expect(out.act.status).toBe('success');
    expect(requests).toHaveLength(1); // 走了 LLM（验收 bug 的回归锚）
    const data = out.signals[0]!.data as { adjudication: Record<string, number> };
    expect(data.adjudication.keptSplit).toBe(1);
    expect(data.adjudication.autoMerged).toBe(0);
    db.close();
  });

  it('reason 含大括号不破坏 JSON 解析（字符串感知括号配对）', async () => {
    const store = new InMemoryConceptGraph();
    await store.admitConcept({ name: '戊概念', kind: 'construct', supportCount: 2 });
    const right = await store.admitConcept({ name: '戊概念', kind: 'entity', supportCount: 2 });
    const out = await consolidateHandler(
      { payload: {} } as never,
      {
        [DEP_CONCEPT_GRAPH_KEY]: store,
        [DEP_MEMORY_STORE_KEY]: await memoryStoreWith(),
        [DEP_LLM_PORT]: mockLlm(() =>
          JSON.stringify({
            decisions: [
              { candidateId: right.candidateId, action: 'keep_split', reason: '形如 {a} 的噪音' },
            ],
          }),
        ),
      },
    );
    expect(out.act.status).toBe('success');
    const data = out.signals[0]!.data as { adjudication: Record<string, number> };
    expect(data.adjudication.keptSplit).toBe(1);
  });
});
