/**
 * Summary executor — Prompt 组装 + provider.chat + structured 校验
 *
 * @module harness/capabilities/summary/executor
 */

import type { LLMMessage, ModelProvider } from '../../../core/interfaces/model-provider.js';
import { estimateTextTokens } from '../../context/token-estimate-fns.js';
import { computeInputBudget } from './budget.js';
import {
  coverageFromOversized,
  mergeChunkSummaries,
  planChunks,
  shouldRejectPartial,
} from './oversized.js';
import { extractStructured } from './structured.js';
import type {
  ContentKind,
  SummaryCoverage,
  SummaryPolicy,
  SummaryResult,
  StructuredValidator,
} from './types.js';

export interface ExecuteSummaryParams {
  text: string;
  kind: ContentKind;
  policy: SummaryPolicy;
  task?: string;
  provider: ModelProvider;
  model?: string;
  contextWindow?: number;
  defaultInputBudgetTokens?: number;
  safetyMarginTokens?: number;
  previousSummary?: string;
  validator?: StructuredValidator;
  signal?: AbortSignal;
}

/**
 * 构建 system prompt
 *
 * @param policy - 策略
 * @param task - 调用方意图
 * @param maxOut - 输出预算
 * @returns system 文本
 */
export function buildSystemPrompt(policy: SummaryPolicy, task: string | undefined, maxOut: number): string {
  if (policy.systemPromptTemplate) {
    return policy.systemPromptTemplate
      .replace('{maxTokens}', String(maxOut))
      .replace('{task}', task ?? policy.goalHint ?? '');
  }
  const include = policy.extract.include.map((s) => `- ${s}`).join('\n');
  const exclude = policy.extract.exclude.map((s) => `- ${s}`).join('\n');
  const preserve = policy.preserve.map((s) => `- ${s}`).join('\n');
  const fields =
    policy.output === 'structured_json' && policy.fields?.length
      ? `\nReturn a single JSON object with fields: ${policy.fields.join(', ')}. No markdown fences.`
      : policy.output === 'structured_json'
        ? `\nReturn a single JSON object only. No markdown fences.`
        : '';
  const goal = task?.trim() || policy.goalHint?.trim() || 'Extract useful information from the content.';

  return `You are a content summarizer and information extractor.

Goal:
${goal}

Include:
${include || '- useful facts'}

Exclude:
${exclude || '- noise'}

Preserve exactly when present:
${preserve || '- identifiers and numbers'}

Rules:
1. Prefer facts over pleasantries.
2. Do not invent data that is not in the content.
3. If content is truncated, state that clearly.
4. Keep output under ${maxOut} tokens.
${fields}

Content kind hint: ${policy.id}`;
}

/**
 * 执行一次摘要/提取（含 oversized）
 *
 * @param params - 执行参数
 * @returns SummaryResult
 */
export async function executeSummary(params: ExecuteSummaryParams): Promise<SummaryResult> {
  const { policy, provider, model } = params;
  const inputBudget = computeInputBudget({
    policy,
    contextWindow: params.contextWindow,
    defaultInputBudgetTokens: params.defaultInputBudgetTokens,
    safetyMarginTokens: params.safetyMarginTokens,
  });

  const tokensIn = estimateTextTokens(params.text);
  const maxOut = policy.budget.maxOutputTokens;
  const system = buildSystemPrompt(policy, params.task, maxOut);

  const chatOnce = async (content: string): Promise<{ text: string; tokensOut: number }> => {
    const messages: LLMMessage[] = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: params.previousSummary
          ? `Previous summary:\n${params.previousSummary}\n\n---\n\nNew content:\n${content}`
          : content,
      },
    ];
    const res = await provider.chat({
      messages,
      model,
      temperature: policy.temperature ?? 0.2,
      maxTokens: maxOut,
      signal: params.signal,
    });
    return { text: res.content ?? '', tokensOut: res.usage?.completionTokens ?? estimateTextTokens(res.content ?? '') };
  };

  const finish = (
    text: string,
    coverage: SummaryCoverage,
    tokensOut: number,
    chunks?: { total: number; processed: number },
    structuredError?: string,
    structured?: unknown,
  ): SummaryResult => {
    const base: SummaryResult = {
      text,
      coverage,
      tokensIn,
      tokensOut,
      policyId: policy.id,
      kind: params.kind,
      model,
      chunks,
      truncatedInput: coverage === 'windowed' || coverage === 'truncated',
    };
    if (policy.output === 'structured_json') {
      const parsed = structuredError
        ? { structuredError, structured: undefined }
        : structured !== undefined
          ? { structured }
          : extractStructured(text, policy, params.validator);
      return { ...base, text, structured: parsed.structured, structuredError: parsed.structuredError };
    }
    return base;
  };

  try {
    if (tokensIn <= inputBudget) {
      const r = await chatOnce(params.text);
      if (policy.output === 'structured_json') {
        const st = extractStructured(r.text, policy, params.validator);
        return finish(r.text, st.structuredError ? 'partial' : 'full', r.tokensOut, undefined, st.structuredError, st.structured);
      }
      return finish(r.text, 'full', r.tokensOut);
    }

    const oversized = policy.oversized;
    if (oversized.strategy === 'fail') {
      // 契约：显式 fail 策略在能力层失败；工具侧 applyToolSummary 捕获后回退 L1
      throw new Error(
        `summary oversized: input tokens ${tokensIn} exceed budget ${inputBudget} (strategy=fail)`,
      );
    }

    if (oversized.strategy === 'truncate_fallback') {
      return finish(
        `[truncated input for summary] ${params.text.slice(0, Math.max(200, inputBudget * 2))}`,
        'truncated',
        0,
      );
    }

    if (oversized.strategy === 'window') {
      const headBudget = Math.floor(inputBudget * 0.45);
      const tailBudget = Math.floor(inputBudget * 0.45);
      const charsPerToken = 4;
      const head = params.text.slice(0, headBudget * charsPerToken);
      const tail = params.text.slice(Math.max(0, params.text.length - tailBudget * charsPerToken));
      const windowed = `${head}\n\n[...content windowed...]\n\n${tail}`;
      const r = await chatOnce(windowed);
      return finish(r.text, 'windowed', r.tokensOut);
    }

    // map_reduce
    const maxChunks = oversized.maxChunks ?? 6;
    const overlap = oversized.chunkOverlapTokens ?? 200;
    const plan = planChunks(params.text, inputBudget, overlap, maxChunks);
    const parts: string[] = [];
    for (const chunk of plan.chunks) {
      const r = await chatOnce(chunk);
      parts.push(r.text);
      if (params.signal?.aborted) break;
    }
    let merged = mergeChunkSummaries(parts);
    let tokensOut = estimateTextTokens(merged);
    // reduce if still huge
    if (estimateTextTokens(merged) > inputBudget && parts.length > 1) {
      const r = await chatOnce(merged);
      merged = r.text;
      tokensOut = r.tokensOut;
    }
    const coverage = coverageFromOversized(oversized, parts.length, plan, false, false);
    if (shouldRejectPartial(oversized, coverage)) {
      throw new Error(
        `summary oversized: partial coverage (${parts.length}/${plan.chunks.length} chunks, complete=${plan.complete}) rejected by onPartial=reject`,
      );
    }
    if (policy.output === 'structured_json') {
      const st = extractStructured(merged, policy, params.validator);
      return finish(
        merged,
        st.structuredError && coverage === 'full' ? 'partial' : coverage,
        tokensOut,
        { total: plan.chunks.length, processed: parts.length },
        st.structuredError,
        st.structured,
      );
    }
    return finish(merged, coverage, tokensOut, { total: plan.chunks.length, processed: parts.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // fail / onPartial=reject 是能力层契约错误，不降级掩盖
    if (
      policy.oversized.strategy === 'fail' ||
      message.includes('onPartial=reject') ||
      message.includes('strategy=fail')
    ) {
      throw err;
    }
    // 其它 LLM 失败：降级窗口截断文本，不 throw 到 Loop（工具 L1 再兜底）
    const fallback = `[summary failed: ${message}]\n${params.text.slice(0, 1500)}`;
    return finish(fallback, 'truncated', 0);
  }
}
