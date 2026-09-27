/**
 * LLM 意图分流 — 轻量结构化调用（arch §6.3.1）
 *
 * 只决定注入形态；失败/超时由 resolveInjectPlan fail-open。
 */

import type { ModelProvider } from '../../../core/interfaces/model-provider.js';
import type { AttachmentInjectPlan, SessionAttachment } from './types.js';
import type { AttachmentIntentInput, AttachmentIntentResolver } from './intent.js';

const INTENT_SYSTEM = `You triage how to open uploaded attachments for an agent.
Return ONLY a compact JSON object, no prose.

Schema:
{
  "mode": "structure_tools" | "recall_tools" | "overview_tools",
  "focus": "<short retrieval phrase or empty>",
  "targets": ["<attachment name>", ...] or empty,
  "reason": "<one short sentence>"
}

Rules:
- structure_tools: task needs most of the document(s) (summarize/translate/review whole file).
- recall_tools: task is about a local topic; set focus to a short search phrase (keep entity names).
- overview_tools: intent is vague or multi-interpret.
- Do NOT classify as whole-doc just because a word like "翻译/translate" appears in a filename (e.g. "翻译稿" is a document title).
- Prefer recall/structure over injecting full text when documents are long.
- targets lists only attachment names involved when the user clearly means specific files.`;

/**
 * 用 ModelProvider 做一次短 chat 的意图分流
 *
 * @param provider - 已绑定模型名的 provider
 * @param opts - temperature / maxTokens
 */
export function createLlmIntentResolver(
  provider: ModelProvider,
  opts?: { temperature?: number; maxTokens?: number },
): AttachmentIntentResolver {
  return async (input: AttachmentIntentInput): Promise<AttachmentInjectPlan> => {
    const lines: string[] = [
      `USER TASK:`,
      input.userText.slice(0, 2000),
      ``,
      `ATTACHMENTS:`,
    ];
    for (const a of input.attachments as SessionAttachment[]) {
      const outline = input.outlines?.[a.name];
      lines.push(
        `- ${a.name} | ${a.kind} | ${a.sizeBytes}B | status=${a.status}${outline ? ` | ${outline.slice(0, 200)}` : ''}`,
      );
    }

    const response = await provider.chat({
      messages: [
        { role: 'system', content: INTENT_SYSTEM },
        { role: 'user', content: lines.join('\n') },
      ],
      temperature: opts?.temperature ?? 0,
      maxTokens: opts?.maxTokens ?? 300,
    });

    const raw = (response.content ?? '').trim();
    const jsonText = extractJsonObject(raw);
    const parsed = JSON.parse(jsonText) as {
      mode?: string;
      focus?: string;
      targets?: string[];
      reason?: string;
    };
    const mode =
      parsed.mode === 'structure_tools' ||
      parsed.mode === 'recall_tools' ||
      parsed.mode === 'overview_tools'
        ? parsed.mode
        : 'structure_tools';
    return {
      mode,
      focus: typeof parsed.focus === 'string' && parsed.focus.trim() ? parsed.focus.trim().slice(0, 400) : undefined,
      targets: Array.isArray(parsed.targets)
        ? parsed.targets.filter((t): t is string => typeof t === 'string')
        : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'llm-intent',
    };
  };
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}
