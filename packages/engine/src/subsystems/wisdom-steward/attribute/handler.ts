/**
 * wisdom.steward.attribute — 弱归因判决（digest 批量 LLM 判决）
 *
 * 输入：归因窗口（run 收尾记账）；判决只出自 LLM（digest + 引用摘录）。
 * 输出：assisted/contested 事件 → `wisdom.steward.evaluate.request`（evaluate 入账）。
 * 失败语义：缺 store/llmPort、LLM 错误、解析失败/覆盖率不符 → act.status=failed，
 * **窗口保持 pending**（下批再判）；宁可整批失败重试，不静默吞窗口。
 * 只写 WisdomStore（E3）；不写 Memory / Cognition / Knowledge。
 *
 * @module
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
  WisdomOutcomeEvent,
  WisdomStore,
} from '@octopi-agent/engine/harness/memory/types.js';
import type { EventBus } from '@octopi-agent/core/primitives/event-bus.js';
import {
  DEP_LLM_PORT,
  DEP_SUBSYSTEM_PROMPT,
  chatForCompleteOutput,
  type SubsystemLLMPort,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/index.js';
import {
  buildAttributionDigest,
  emitWisdomEvaluateRequest,
  parseAttributionVerdicts,
  planAttributionBatch,
  verdictsToOutcomeEvents,
} from '../../../harness/memory/index.js';

const DEP_WISDOM = 'wisdomStore';
const DEP_EVENT_BUS = 'eventBus';
const DEP_CONFIG = '__subsystem_config__';

interface AttributeConfig {
  /** 演练：只报判决结果，不标记窗口、不发事件、不清理（消费性操作全关） */
  dryRun?: boolean;
  /** 判决候选总上限（窗口×条目对）；超出的窗口整窗推迟下批 */
  maxPairs?: number;
  /** core 常驻抽样上限 */
  sampleMax?: number;
  /** 一次取多少未判决窗口 */
  maxWindows?: number;
  /** LLM 生成配额（传参，非业务截断）；缺省 4096 */
  maxTokens?: number;
  /** 已判决窗口保留期（毫秒）；缺省 30 天 */
  windowRetentionMs?: number;
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
      messages: [{ role: 'system', content: `wisdom.steward.attribute.failed reason=${reason}` }],
    },
    signals: [{ action: 'alert', reason: message, data: { reason } }],
  };
}

function skipOutput(detail: string, data: Record<string, unknown>): SubsystemOutput {
  return {
    act: {
      mode: 'inject',
      status: 'success',
      target: 'wisdom-store',
      messages: [{ role: 'system', content: `wisdom.steward.attribute.skipped ${detail}` }],
    },
    signals: [{ action: 'suggest', reason: 'attribute_skipped', data }],
  };
}

async function handler(
  _input: SubsystemInput,
  deps?: InjectedDependencies,
): Promise<SubsystemOutput> {
  const wisdomStore = deps?.[DEP_WISDOM] as WisdomStore | undefined;
  if (!wisdomStore) throw new Error('wisdom.steward.attribute: wisdomStore not injected');
  const config = (deps?.[DEP_CONFIG] as AttributeConfig | undefined) ?? {};
  const dryRun = config.dryRun ?? false;
  const now = Date.now();

  // 保留期清理放入口：所有退出路径都执行（含提前返回/失败）
  if (!dryRun) {
    await wisdomStore.pruneWindows(now - (config.windowRetentionMs ?? 2592000000));
  }

  const windows = await wisdomStore.listPendingWindows(config.maxWindows ?? 500);
  if (windows.length === 0) return skipOutput('reason=no_pending_windows', {});

  const alive = await wisdomStore.listForGovern({ includeRetired: false });
  const batch = planAttributionBatch(windows, alive, {
    sampleMax: config.sampleMax ?? 2,
    maxPairs: config.maxPairs ?? 40,
  });

  if (batch.selected.length === 0) {
    // 无候选或抽样未中：按设计关闭（判无可判）；被 maxPairs 推迟的保持 pending
    if (!dryRun) await wisdomStore.markWindowsJudged(batch.closableWindowIds, now);
    return skipOutput(
      `reason=no_candidates windows=${windows.length} closed=${batch.closableWindowIds.length} deferred=${batch.deferredWindowIds.length}`,
      {
        windows: windows.length,
        closedNoCandidate: batch.closableWindowIds.length,
        cutByMaxPairs: batch.deferredWindowIds.length,
      },
    );
  }

  const llmPort = deps?.[DEP_LLM_PORT] as SubsystemLLMPort | undefined;
  if (!llmPort?.chat) return failOutput('llmPort missing', 'llm_port_missing');

  const { text: digest, pairRefs } = buildAttributionDigest(batch.selected);
  const expectedPairs = batch.selected.map((_, i) => i + 1);
  const outcome = await chatForCompleteOutput(
    llmPort,
    {
      systemPrompt: resolveSubsystemPrompt(deps, llmPort) || undefined,
      messages: [{ role: 'user', content: digest }],
      maxTokens: config.maxTokens ?? 4096,
    },
    (text) => parseAttributionVerdicts(text, expectedPairs),
  );
  // parse_failed 已含覆盖率不符（缺项/重复/空 items）：窗口保持 pending，下批再判
  if (!outcome.ok) return failOutput(outcome.message, outcome.reason);

  const verdicts = outcome.parsed.items;
  const events: WisdomOutcomeEvent[] = verdictsToOutcomeEvents(verdicts, pairRefs, now);
  const judgeWindowIds = [...new Set(batch.selected.map((c) => c.window.id))];
  const closeIds = [...new Set([...judgeWindowIds, ...batch.closableWindowIds])];

  if (dryRun) {
    // 演练：不标记、不发事件、不清理——一切消费性操作全关
    return {
      act: {
        mode: 'inject',
        status: 'success',
        target: 'wisdom-store',
        messages: [{
          role: 'system',
          content:
            `wisdom.steward.attributed dryRun=true pairs=${batch.selected.length} ` +
            `events=${events.length} deferred=${batch.deferredWindowIds.length}`,
        }],
      },
      signals: [{
        action: 'suggest',
        reason: 'attribute_dry_run',
        data: {
          pairs: batch.selected.length,
          verdicts: verdicts.map((v) => ({ pair: v.pair, verdict: v.verdict })),
          events,
          cutByMaxPairs: batch.deferredWindowIds.length,
          dryRun: true,
        },
      }],
    };
  }

  // 先标记 judged 再发判决事件：宁丢勿重（重复入账会污染 confidence / contestRate）。
  // 只对本次真正标记到的窗口发事件（markWindowsJudged 返回值）：跨进程重复判决不双记。
  const newlyJudged = await wisdomStore.markWindowsJudged(closeIds, now);
  const claimed = new Set(newlyJudged);
  const emitEvents = events.filter((e) => e.ref && claimed.has(e.ref));
  if (emitEvents.length > 0) {
    emitWisdomEvaluateRequest(deps?.[DEP_EVENT_BUS] as EventBus | undefined, { events: emitEvents });
  }

  return {
    act: {
      mode: 'inject',
      status: 'success',
      target: 'wisdom-store',
      messages: [{
        role: 'system',
        content:
          `wisdom.steward.attributed pairs=${batch.selected.length} events=${emitEvents.length} ` +
          `closed=${newlyJudged.length} deferred=${batch.deferredWindowIds.length}`,
      }],
    },
    signals: [{
      action: 'suggest',
      reason: 'attribute_completed',
      data: {
        pairs: batch.selected.length,
        verdicts: verdicts.map((v) => ({ pair: v.pair, verdict: v.verdict })),
        events: emitEvents,
        closed: newlyJudged.length,
        cutByMaxPairs: batch.deferredWindowIds.length,
        dryRun: false,
      },
    }],
  };
}

export default {
  handler,
  contract: { input: 'WisdomAttributeInput', output: 'WisdomAttributeResult' },
  dependencies: [DEP_WISDOM],
};

export { handler };
