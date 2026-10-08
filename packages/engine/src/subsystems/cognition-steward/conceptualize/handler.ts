/**
 * cognition.steward.conceptualize — 命题 + contextSlice → 概念/边（持证）
 *
 * 失败语义：缺 llmPort / LLM 错误 / 解析失败 → act.status=failed。
 * 只写 ConceptGraphStore（E3）；不写 Memory / Wisdom / Knowledge。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  SubsystemInput,
  SubsystemOutput,
  InjectedDependencies,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/types.js';
import type { ConceptGraphStore, MemoryStatus } from '@octopi-agent/engine/harness/memory/types.js';
import {
  DEP_LLM_PORT,
  DEP_SUBSYSTEM_PROMPT,
  type SubsystemLLMPort,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/index.js';
import {
  conceptualizeAndAdmit,
  parseConceptualizerJson,
} from '../../../harness/memory/conceptualizer.js';

const DEP_CONCEPT_GRAPH = 'conceptGraphStore';
const DEP_CONFIG = '__subsystem_config__';

interface ConceptualizeConfig {
  maxNodesPerProposition?: number;
  maxEdgesPerProposition?: number;
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
      target: 'concept-graph',
      messages: [{ role: 'system', content: `cognition.steward.conceptualize.failed reason=${reason}` }],
    },
    signals: [{ action: 'alert', reason: message, data: { reason } }],
  };
}

async function handler(
  input: SubsystemInput,
  deps?: InjectedDependencies,
): Promise<SubsystemOutput> {
  const store = deps?.[DEP_CONCEPT_GRAPH] as ConceptGraphStore | undefined;
  if (!store) {
    throw new Error('cognition.steward.conceptualize: conceptGraphStore not injected');
  }

  const llmPort = deps?.[DEP_LLM_PORT] as SubsystemLLMPort | undefined;
  if (!llmPort?.chat) {
    return failOutput('llmPort missing', 'llm_port_missing');
  }

  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const proposition = String(payload.proposition ?? '').trim();
  const memoryId = String(payload.memoryId ?? '');
  const evidence = String(payload.evidence ?? '');
  const contextSlice = String(payload.contextSlice ?? payload.context_slice ?? '');
  const memoryType = (String(payload.memoryType ?? payload.type ?? 'fact') as 'fact' | 'method' | 'norm');
  const memoryStatus = (payload.memoryStatus as MemoryStatus | undefined) ?? undefined;

  if (!proposition || !memoryId) {
    return failOutput('missing proposition/memoryId', 'bad_payload');
  }
  if (!contextSlice.trim() && !evidence.trim()) {
    return failOutput('no context slice', 'no_context_slice');
  }

  const systemPrompt = resolveSubsystemPrompt(deps, llmPort);
  const userText = [
    `memoryType: ${memoryType}`,
    `proposition: ${proposition}`,
    `evidence: ${evidence}`,
    `contextSlice: ${contextSlice}`,
  ].join('\n');

  let llmText = '';
  try {
    const res = await llmPort.chat({
      systemPrompt: systemPrompt || undefined,
      messages: [{ role: 'user', content: userText }],
      temperature: 0.2,
      maxTokens: 2048,
    });
    if (res.finishReason === 'error') {
      return failOutput(res.content || 'llm chat error', 'llm_error');
    }
    llmText = res.content ?? '';
  } catch (err) {
    return failOutput(err instanceof Error ? err.message : String(err), 'llm_error');
  }

  const parsed = parseConceptualizerJson(llmText);
  if (!parsed) {
    return failOutput('parse_failed', 'parse_failed');
  }

  const result = await conceptualizeAndAdmit(
    parsed,
    {
      proposition,
      memoryId,
      memoryType,
      evidence,
      contextSlice,
      memoryStatus,
    },
    store,
  );

  const created = result.nodes.filter((n) => n.admit.action === 'created' || n.admit.action === 'merged').length;
  const edgesIn = result.edges.filter((e) => e.admit && e.admit.action !== 'rejected').length;

  return {
    act: {
      mode: 'inject',
      status: 'success',
      target: 'concept-graph',
      messages: [
        {
          role: 'system',
          content: `cognition.steward.conceptualized nodes=${created} edges=${edgesIn} rejected=${result.rejected.length}`,
        },
      ],
    },
    signals: [
      {
        action: 'suggest',
        reason: 'conceptualized',
        data: {
          memoryId,
          nodes: created,
          edges: edgesIn,
          rejected: result.rejected,
        },
      },
    ],
  };
}

export default handler;
