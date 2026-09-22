/**
 * 工具侧 L1/L2 收口
 *
 * 命名说明（避免踩坑）：
 * - **L1** = 字符硬顶（`applyL1Truncate`），**永远执行**，与 `mode` 无关
 * - **L2** = SummaryPort 的 LLM 摘要，可选；`mode: 'never'` / `summarize: 'off'` 时跳过
 * - 本模块入口叫 `applyToolOutputGate`（不是 “summary only”）：它同时做 L1 + 可选 L2
 *
 * @module harness/capabilities/summary/tool-binding
 */

import { applyL1Truncate } from './gate.js';
import { createDefaultToolBindings, defaultKindForTool, kindFromContentType, kindFromExtension, resolveToolBinding } from './registry.js';
import type {
  ContentChannel,
  ContentKind,
  ContentUnit,
  SummaryPort,
  SummaryResult,
  ToolSummaryBinding,
} from './types.js';

/**
 * 工具侧输出门控注入对象（L1 binding + 可选 L2 SummaryPort）。
 *
 * 名字里的 Summary 指可选 L2；**L1 由 `maxReturnChars` / binding 负责，不依赖 port**。
 * `binding` 为单工具预解析结果；未提供时用 `toolBindings` + `maxReturnCharsDefault`
 * 按工具名统一解析（与配置 `summary.tools.*` 同源，避免双入口）。
 */
export interface ToolSummarySupport {
  /** L2 摘要端口；缺失时只做 L1 */
  port?: SummaryPort;
  /** 预解析的单工具 binding（优先） */
  binding?: ToolSummaryBinding;
  /** 配置覆盖表：tool 名 → partial binding */
  toolBindings?: Record<string, Partial<ToolSummaryBinding>>;
  /** 无工具级 maxReturnChars 时的全局 L1 缺省 */
  maxReturnCharsDefault?: number;
}

/**
 * 从 support 解析某工具的 binding（唯一入口）
 *
 * @param tool - 工具名
 * @param support - 注入的 summary support
 * @param fallbackMaxReturnChars - support 完全缺失时的 L1 缺省
 * @returns 合并后的 binding
 */
export function resolveSupportBinding(
  tool: string,
  support: ToolSummarySupport | undefined,
  fallbackMaxReturnChars: number,
): ToolSummaryBinding {
  if (support?.binding?.tool === tool) return support.binding;
  return resolveToolBinding(
    tool,
    createDefaultToolBindings(),
    support?.toolBindings,
    support?.maxReturnCharsDefault ?? fallbackMaxReturnChars,
  );
}

export type AgentSummarizeArg = 'auto' | 'force' | 'off' | undefined;

export interface ApplyToolOutputGateInput {
  tool: string;
  rawBody: string;
  support?: ToolSummarySupport;
  channel?: ContentChannel;
  locator?: string;
  contentType?: string;
  extension?: string;
  kind?: ContentKind;
  task?: string;
  policyId?: string;
  summarizeArg?: AgentSummarizeArg;
  /** L1 截断后的续读提示 */
  truncateHint: string;
}

export interface ApplyToolOutputGateOutput {
  /** 最终进主会话的正文（已过 L1；若跑了 L2 则为摘要结果） */
  body: string;
  /** L1 是否截断（含 hint 总长约束） */
  bodyTruncated: boolean;
  rawSizeBytes: number;
  rawLength: number;
  /** L2 摘要元数据；未跑 L2 时 skipped/failed */
  summary?: {
    applied: boolean;
    skipped?: boolean;
    skipReason?: string;
    failed?: boolean;
    policyId?: string;
    kind?: ContentKind;
    coverage?: SummaryResult['coverage'];
    tokensIn?: number;
    tokensOut?: number;
    structuredError?: string;
  };
  /** Summary LLM 调用的 usage（用于 UsageLedger 归因；仅 L2） */
  usage?: import('../../../core/types/turn.js').TokenUsage;
}

/**
 * 工具结果出口门控：**L1 硬顶（永远）+ 可选 L2 摘要**
 *
 * - `mode: 'never'` / `summarizeArg: 'off'`：**只关 L2**，L1 仍截断
 * - L2 失败且 `onFail: 'truncate_l1'`：回退 L1，不向 Loop 抛错
 *
 * @param input - 原始 body 与元数据
 * @returns 最终返回给 LLM 的 body 与 summary 元数据
 */
export async function applyToolOutputGate(input: ApplyToolOutputGateInput): Promise<ApplyToolOutputGateOutput> {
  const support = input.support;
  const binding = resolveSupportBinding(input.tool, support, defaultL1ForTool(input.tool));
  const port = support?.port;
  const maxChars = binding.maxReturnChars;
  const rawLength = input.rawBody.length;
  const rawSizeBytes = Buffer.byteLength(input.rawBody, 'utf-8');

  const kind =
    input.kind ??
    (binding?.kindFromSource === false
      ? defaultKindForTool(input.tool)
      : inferKind(input));

  const unit: ContentUnit = {
    text: input.rawBody,
    channel: input.channel ?? 'tool',
    source: {
      tool: input.tool,
      locator: input.locator,
      contentType: input.contentType,
      extension: input.extension,
      sizeBytes: rawSizeBytes,
    },
    kind,
    task: input.task,
    policy: input.policyId,
  };

  const mode = binding?.mode ?? 'auto';
  const arg = input.summarizeArg ?? 'auto';

  const finish = (body: string, truncated: boolean, summary: ApplyToolOutputGateOutput['summary'], usage?: import('../../../core/types/turn.js').TokenUsage): ApplyToolOutputGateOutput => ({
    body,
    bodyTruncated: truncated,
    rawSizeBytes,
    rawLength,
    summary,
    usage,
  });

  // L2 决策（L1 在所有分支末尾都会做）
  let runL2 = false;
  if (mode === 'never' || arg === 'off') {
    runL2 = false;
  } else if (arg === 'force' || mode === 'always') {
    runL2 = true;
  } else if (mode === 'kind_sensitive') {
    // 仅明确「信息型」kind 才 L2；auto/opaque 不摘要（保护源文件/未知形态）
    const list = binding.informationalKinds ?? [];
    runL2 = list.includes(kind);
  } else {
    // auto / over_threshold：是否真正 extract 由 gate 决定
    runL2 = true;
  }

  if (runL2 && port) {
    const need = arg === 'force' || mode === 'always' || port.shouldProcess(unit, binding.gate);
    if (arg === 'force' || mode === 'always' || need) {
      try {
        const r = await port.extract(unit, { previousSummary: undefined });
        if (r.skipped) {
          const l1 = applyL1Truncate(input.rawBody, maxChars, input.truncateHint);
          return finish(l1.text, l1.truncated, {
            applied: false,
            skipped: true,
            skipReason: r.skipReason,
            kind,
          });
        }
        const l1 = applyL1Truncate(r.text, maxChars, input.truncateHint);
        return finish(l1.text, l1.truncated, {
          applied: true,
          policyId: r.policyId,
          kind: r.kind,
          coverage: r.coverage,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          structuredError: r.structuredError,
        }, r.usage);
      } catch (err) {
        if (binding.onFail === 'error') throw err;
        const l1 = applyL1Truncate(input.rawBody, maxChars, input.truncateHint);
        return finish(l1.text, l1.truncated, {
          applied: false,
          failed: true,
          kind,
        });
      }
    } else {
      const l1 = applyL1Truncate(input.rawBody, maxChars, input.truncateHint);
      return finish(l1.text, l1.truncated, {
        applied: false,
        skipped: true,
        skipReason: 'below_gate',
        kind,
      });
    }
  } else if (runL2 && !port) {
    const l1 = applyL1Truncate(input.rawBody, maxChars, input.truncateHint);
    return finish(l1.text, l1.truncated, {
      applied: false,
      skipped: true,
      skipReason: 'no_summary_port',
      kind,
    });
  }

  // L1 only（mode never / summarize off / 无 L2 路径）
  const l1 = applyL1Truncate(input.rawBody, maxChars, input.truncateHint);
  return finish(l1.text, l1.truncated, {
    applied: false,
    skipped: true,
    skipReason: arg === 'off' ? 'summarize_off' : mode === 'never' ? 'mode_never' : 'l1_only',
    kind,
  });
}

function defaultL1ForTool(tool: string): number {
  return createDefaultToolBindings()[tool]?.maxReturnChars ?? 8000;
}

function inferKind(input: ApplyToolOutputGateInput): ContentKind {
  if (input.contentType) {
    const k = kindFromContentType(input.contentType);
    if (k !== 'auto') return k;
  }
  if (input.extension) {
    const k = kindFromExtension(input.extension);
    if (k !== 'auto') return k;
  }
  return defaultKindForTool(input.tool);
}