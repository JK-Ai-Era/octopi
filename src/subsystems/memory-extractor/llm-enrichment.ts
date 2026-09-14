/**
 * Memory Extractor Subsystem — LLM 语义增强
 *
 * 在规则提取之后，用 LLM 从 bundle 中提取规则引擎无法识别的隐式记忆。
 * **不内置 system prompt**：认知指令来自 SUBSYSTEM.md，经 llmPort 注入。
 *
 * @module subsystems/memory-extractor/llm-enrichment
 */

import type { LLMMessage, LLMResponse } from '../../core/interfaces/model-provider.js';
import type {
  SessionExtractBundle,
  SessionExtractEvent,
  MemoryCandidate,
} from './contracts/bundle.js';

// ── 配置 ──

export interface LLMEnrichmentConfig {
  /** 最大输出 token */
  maxTokens?: number;
  /** 温度（默认 0.3，低温度保证输出稳定） */
  temperature?: number;
}

/** 增强用的单次 LLM 调用（通常为 llmPort.chat） */
export type EnrichmentChat = (request: {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}) => Promise<LLMResponse>;

// ── 事件压缩 ──

/**
 * 将 bundle 事件压缩为人类可读的文本摘要（供 LLM 理解）
 *
 * 设计原则：
 * - 保留关键语义信息，丢弃纯技术细节
 * - 每个事件一行，格式统一
 * - 输出语言与事件 payload 原始语言一致
 */
export function condenseEvents(events: SessionExtractEvent[]): string {
  const lines: string[] = [];

  for (const evt of events) {
    const text = evt.payload?.text as string | undefined;
    const toolName = evt.payload?.toolName as string | undefined;
    const result = evt.payload?.result as string | undefined;

    switch (evt.type) {
      case 'goal_set':
        lines.push(`[目标] ${text ?? '(未记录)'}`);
        break;
      case 'goal_change':
        lines.push(`[目标变更] ${text ?? '(未记录)'}`);
        break;
      case 'constraint_set':
        lines.push(`[约束] ${text ?? '(未记录)'}`);
        break;
      case 'decision_made':
        lines.push(`[决策] ${text ?? '(未记录)'}`);
        break;
      case 'decision_override':
        lines.push(`[决策覆盖] ${text ?? '(未记录)'}`);
        break;
      case 'user_confirm':
        lines.push(`[用户确认] ${text ?? '(未记录)'}`);
        break;
      case 'user_reject':
        lines.push(`[用户拒绝] ${text ?? '(未记录)'}`);
        break;
      case 'tool_call':
        lines.push(`[工具调用] ${toolName ?? 'unknown'}`);
        break;
      case 'tool_failure':
        lines.push(`[工具失败] ${toolName ?? 'unknown'}: ${result ?? 'unknown error'}`);
        break;
      case 'tool_success':
        lines.push(`[工具成功] ${toolName ?? 'unknown'}`);
        break;
      case 'fix_applied':
        lines.push(`[修复成功] ${toolName ?? 'unknown'}`);
        break;
      case 'error':
        lines.push(`[错误] ${result ?? text ?? 'unknown'}`);
        break;
      case 'assistant_summary':
        lines.push(`[助手总结] ${text ?? '(未记录)'}`);
        break;
    }
  }

  return lines.join('\n');
}

// ── Prompt 构建（仅 user 消息；system 由 llmPort 绑定 SUBSYSTEM.md） ──

/**
 * 构建用户消息
 */
function buildUserMessage(
  bundle: SessionExtractBundle,
  condensedText: string,
  ruleCandidates: MemoryCandidate[],
): string {
  const parts: string[] = [];

  parts.push(`## 会话信息\n- sessionId: ${bundle.sessionId}`);
  parts.push(`- 事件数量: ${bundle.events.length}`);
  parts.push(`- 运行摘要: 失败率=${(bundle.runSummary.failureRate * 100).toFixed(0)}%, 主要错误=${bundle.runSummary.majorErrors.length}, 已修复=${bundle.runSummary.resolvedErrors.length}`);

  parts.push(`\n## 会话事件\n${condensedText}`);

  if (ruleCandidates.length > 0) {
    parts.push('\n## 规则引擎已提取的候选（供参考，你可以提取更丰富的内容）');
    for (const c of ruleCandidates) {
      parts.push(`- [${c.type}] ${c.content} (confidence=${c.confidence}, importance=${c.importance})`);
    }
  }

  parts.push('\n请从上述会话事件中提取值得长期记住的信息。输出严格 JSON 数组。');

  return parts.join('\n');
}

// ── LLM 调用与解析 ──

/**
 * 从 LLM 响应中提取 JSON 数组
 */
function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown[];
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 将 LLM 输出解析为 MemoryCandidate[]
 *
 * 容错设计：
 * - JSON 解析失败 → 返回空数组
 * - 单条格式不合法 → 跳过该条，继续处理
 * - 类型不在枚举内 → 降级为 discovery
 */
function parseLLMOutput(output: unknown[]): MemoryCandidate[] {
  const validTypes = new Set(['preference', 'decision', 'lesson', 'discovery']);
  const candidates: MemoryCandidate[] = [];

  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;

    const type = typeof obj.type === 'string' && validTypes.has(obj.type)
      ? obj.type as MemoryCandidate['type']
      : 'discovery' as const;

    const content = typeof obj.content === 'string' ? obj.content.trim() : '';
    if (!content) continue;

    const confidence = typeof obj.confidence === 'number'
      ? Math.max(0, Math.min(1, obj.confidence))
      : 0.5;
    const importance = typeof obj.importance === 'number'
      ? Math.max(0, Math.min(1, obj.importance))
      : 0.5;
    const evidence = Array.isArray(obj.evidence)
      ? obj.evidence.filter((e: unknown) => typeof e === 'string') as string[]
      : [];

    candidates.push({
      type,
      content,
      source: 'llm-enrichment',
      evidence,
      confidence,
      importance,
      tags: ['llm'],
    });
  }

  return candidates;
}

// ── 主入口 ──

/**
 * LLM 语义增强：从 bundle 中提取规则引擎无法识别的隐式记忆
 *
 * @param chat - 单次 LLM 调用（llmPort.chat；system prompt 已由 port 绑定）
 * @param bundle - 会话素材包
 * @param ruleCandidates - 规则引擎已提取的候选（供 LLM 参考）
 * @param config - LLM 配置（模型名 / 温度 / maxTokens）
 * @returns LLM 提取的候选列表；调用失败时返回空数组（不阻断流程）
 */
export async function enrichWithLLM(
  chat: EnrichmentChat,
  bundle: SessionExtractBundle,
  ruleCandidates: MemoryCandidate[],
  config?: LLMEnrichmentConfig,
): Promise<MemoryCandidate[]> {
  // 无事件则跳过
  if (bundle.events.length === 0) return [];

  const condensed = condenseEvents(bundle.events);
  const userMessage = buildUserMessage(bundle, condensed, ruleCandidates);

  try {
    // 不传 model：使用 llmPort 按 think.model 解析后的默认链（含 fallback）
    const response = await chat({
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: config?.maxTokens ?? 2048,
      temperature: config?.temperature ?? 0.3,
    });

    if (response.finishReason === 'error' || !response.content) {
      return [];
    }

    const parsed = extractJsonArray(response.content);
    if (!parsed) return [];

    return parseLLMOutput(parsed);
  } catch {
    // LLM 调用失败不阻断提取流程
    return [];
  }
}
