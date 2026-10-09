/**
 * wisdom.steward.formation — Memory/Cognition 稳定结构 → 判断范式
 *
 * 失败语义：缺 store/llmPort、LLM 错误、解析失败 → act.status=failed。
 * 只写 WisdomStore（E3）；不写 Memory / Cognition / Knowledge。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  SubsystemInput,
  SubsystemOutput,
  InjectedDependencies,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/types.js';
import type {
  ConceptGraphStore,
  MemoryStore,
  WisdomStore,
} from '@octopi-agent/engine/harness/memory/types.js';
import {
  DEP_LLM_PORT,
  DEP_SUBSYSTEM_PROMPT,
  type SubsystemLLMPort,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/index.js';
import { formAndAdmit, planPromotionCandidates } from '../../../harness/memory/index.js';

const DEP_WISDOM = 'wisdomStore';
const DEP_MEMORY = 'memoryStore';
const DEP_CONCEPT = 'conceptGraphStore';
const DEP_CONFIG = '__subsystem_config__';

interface FormationConfig {
  maxItemsPerRun?: number;
  minMemorySupport?: number;
  minClusterSize?: number;
  maxEvidenceChars?: number;
  dryRun?: boolean;
  /** T4：晋升候选堆叠阈值（连续/数量） */
  minPromotionStack?: number;
}

function resolveSubsystemPrompt(
  deps: InjectedDependencies | undefined,
  llmPort?: SubsystemLLMPort,
): string {
  const fromDeps = deps?.[DEP_SUBSYSTEM_PROMPT];
  if (typeof fromDeps === 'string' && fromDeps.trim()) return fromDeps;
  if (llmPort?.cognitivePrompt?.trim()) return llmPort.cognitivePrompt;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, 'SUBSYSTEM.md'), 'utf8');
  } catch {
    return '';
  }
}

function failOutput(message: string, reason: string): SubsystemOutput {
  return {
    act: {
      mode: 'inject',
      status: 'failed',
      error: message,
      target: 'wisdom-store',
      messages: [{ role: 'system', content: `wisdom.steward.formation.failed reason=${reason}` }],
    },
    signals: [{ action: 'alert', reason: message, data: { reason } }],
  };
}

/**
 * 聚合炼制原料：promotion 候选 + 同型 method/norm 簇。
 *
 * @param memoryStore - MemoryStore
 * @param minCluster - 触发阈值
 * @param maxChars - 证据包字符上限
 * @returns 证据包文本与 memoryIds
 */
async function buildEvidencePack(
  memoryStore: MemoryStore,
  minCluster: number,
  maxChars: number,
): Promise<{ text: string; memoryIds: string[]; clusterHits: number; promotionCount: number }> {
  const all = await memoryStore.listForGovern({ includeDeleted: false });
  const alive = all.filter((e) => !e.deleted && (e.status ?? 'active') !== 'shadow');
  const promotions = planPromotionCandidates(alive, 20);

  // 按 type+首 tag 聚簇（代码侧选择；语义归 LLM）
  const clusters = new Map<string, typeof alive>();
  for (const e of alive) {
    if (e.type !== 'method' && e.type !== 'norm') continue;
    const key = `${e.type}:${e.tags[0] ?? 'general'}`;
    const list = clusters.get(key) ?? [];
    list.push(e);
    clusters.set(key, list);
  }
  const bigClusters = [...clusters.entries()]
    .filter(([, list]) => list.length >= minCluster)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4);

  const parts: string[] = [];
  const ids = new Set<string>();
  if (promotions.length) {
    parts.push('## 晋升候选（method/norm）');
    for (const p of promotions.slice(0, 10)) {
      parts.push(`- [${p.type}] (${p.id}) ${p.content}`);
      ids.add(p.id);
    }
  }
  for (const [key, list] of bigClusters) {
    parts.push(`## 簇 ${key}（n=${list.length}）`);
    for (const e of list.slice(0, 8)) {
      parts.push(`- [${e.type}] (${e.id}) ${e.content}`);
      if (e.evidence) parts.push(`  证据: ${e.evidence.slice(0, 180)}`);
      ids.add(e.id);
    }
  }
  let text = parts.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return {
    text,
    memoryIds: [...ids],
    clusterHits: bigClusters.length,
    promotionCount: promotions.length,
  };
}

async function handler(
  _input: SubsystemInput,
  deps?: InjectedDependencies,
): Promise<SubsystemOutput> {
  const wisdomStore = deps?.[DEP_WISDOM] as WisdomStore | undefined;
  const memoryStore = deps?.[DEP_MEMORY] as MemoryStore | undefined;
  if (!wisdomStore) throw new Error('wisdom.steward.formation: wisdomStore not injected');
  if (!memoryStore) throw new Error('wisdom.steward.formation: memoryStore not injected');

  const config = (deps?.[DEP_CONFIG] as FormationConfig | undefined) ?? {};
  const minCluster = config.minClusterSize ?? 5;
  const maxChars = config.maxEvidenceChars ?? 6000;
  const maxItems = config.maxItemsPerRun ?? 2;
  const dryRun = config.dryRun ?? false;
  const minPromotionStack = config.minPromotionStack ?? 3;

  const pack = await buildEvidencePack(memoryStore, minCluster, maxChars);
  // 触发器（防「见者有份」）：真实簇 或 晋升候选堆叠；仅有零散材料不打 LLM
  const hasCluster = pack.clusterHits > 0;
  const hasStackedPromotions = pack.promotionCount >= minPromotionStack;
  if (!pack.text.trim() || pack.memoryIds.length < (config.minMemorySupport ?? 2) || (!hasCluster && !hasStackedPromotions)) {
    return {
      act: {
        mode: 'inject',
        status: 'success',
        target: 'wisdom-store',
        messages: [{
          role: 'system',
          content:
            `wisdom.steward.formation.skipped reason=no_trigger memoryIds=${pack.memoryIds.length} ` +
            `clusters=${pack.clusterHits} promotions=${pack.promotionCount}`,
        }],
      },
      signals: [{
        action: 'suggest',
        reason: 'no_trigger',
        data: {
          memoryIds: pack.memoryIds.length,
          clusterHits: pack.clusterHits,
          promotionCount: pack.promotionCount,
        },
      }],
    };
  }

  const llmPort = deps?.[DEP_LLM_PORT] as SubsystemLLMPort | undefined;
  if (!llmPort?.chat) {
    return failOutput('llmPort missing', 'llm_port_missing');
  }

  const systemPrompt = resolveSubsystemPrompt(deps, llmPort);
  // 概念线索（可选；缺失不失败）
  let conceptHint = '';
  const conceptStore = deps?.[DEP_CONCEPT] as ConceptGraphStore | undefined;
  if (conceptStore) {
    try {
      const graph = await conceptStore.getFullGraph();
      const names = graph.nodes
        .filter((n) => n.status !== 'shadow')
        .slice(0, 20)
        .map((n) => n.name);
      if (names.length) conceptHint = `\n概念线索: ${names.join('、')}`;
    } catch {
      // 图不可用不阻断炼制
    }
  }

  let llmText = '';
  try {
    const res = await llmPort.chat({
      systemPrompt: systemPrompt || undefined,
      messages: [{ role: 'user', content: `${pack.text}${conceptHint}` }],
      temperature: 0.3,
      maxTokens: 2048,
    });
    if (res.finishReason === 'error') {
      return failOutput(res.content || 'llm chat error', 'llm_error');
    }
    llmText = res.content ?? '';
  } catch (err) {
    return failOutput(err instanceof Error ? err.message : String(err), 'llm_error');
  }

  const allowedMemoryIds = new Set(pack.memoryIds);
  const { results, droppedNotes } = await formAndAdmit(llmText, wisdomStore, {
    origin: 'distilled',
    maxItems,
    allowedMemoryIds,
    dryRun,
  });
  const created = results.filter((r) => r.action === 'created' || r.action === 'superseded');
  const rejected = results.filter((r) => r.action === 'rejected');

  return {
    act: {
      mode: 'inject',
      status: 'success',
      target: 'wisdom-store',
      messages: [{
        role: 'system',
        content:
          `wisdom.steward.formed created=${created.length} rejected=${rejected.length} ` +
          `dropped=${droppedNotes.length} dryRun=${dryRun}`,
      }],
    },
    signals: [{
      action: 'suggest',
      reason: 'formation_completed',
      data: {
        created: created.map((r) => r.id),
        rejected: rejected.map((r) => ({ reason: r.reason, message: r.message })),
        droppedNotes,
        sourceMemoryIds: pack.memoryIds.slice(0, 30),
        dryRun,
      },
    }],
  };
}

export default {
  handler,
  contract: { input: 'WisdomFormationInput', output: 'WisdomFormationResult' },
  dependencies: [DEP_WISDOM, DEP_MEMORY],
};

export { handler };
