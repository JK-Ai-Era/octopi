/**
 * 会话标题策略 — 临时截断 / 小模型摘要触发条件
 *
 * 目标：历史列表一眼可认；「你好」类碎消息不浪费 LLM 调用。
 */

import type { Message, SessionMeta } from '@octopi-agent/core/types.js';
import { getTextContent } from '@octopi-agent/core/types.js';
import type { SessionData } from './types.js';

/** 首条有效用户消息达到该长度才可直接摘要 */
export const TITLE_MIN_FIRST_USER_CHARS = 16;
/** 累计有效用户内容达到该长度（且至少 1 轮完成）可摘要 */
export const TITLE_MIN_TOTAL_USER_CHARS = 40;
/** 临时截断标题最大长度 */
export const TITLE_SNIPPET_MAX_CHARS = 24;
/** 生成标题最大长度 */
export const TITLE_MAX_CHARS = 40;

/** 参与标题信号统计的用户消息（排除 slash 命令留痕） */
function isTitleRelevantUserMessage(msg: Message): boolean {
  if (msg.role !== 'user') return false;
  const kind = msg.metadata?.kind;
  if (kind === 'command' || kind === 'command_result') return false;
  return true;
}

/** 提取纯文本并压空白 */
function messageText(msg: Message): string {
  return getTextContent(msg.content).replace(/\s+/g, ' ').trim();
}

/** 收集标题相关的用户文本（按时间序） */
export function collectTitleUserTexts(messages: Message[]): string[] {
  return messages.filter(isTitleRelevantUserMessage).map(messageText).filter(Boolean);
}

/**
 * 是否已具备生成摘要标题的语义信号。
 *
 * @param session - 会话数据（用 messages 判断）
 * @returns 首条/最新用户消息够长，或累计用户内容够长且已有助手回复
 */
export function isTitleSignalReady(session: Pick<SessionData, 'messages'>): boolean {
  const userTexts = collectTitleUserTexts(session.messages);
  if (userTexts.length === 0) return false;
  // 首条或「最新一条」够长即可（覆盖「你好」后接复杂问题的场景）
  if (
    userTexts[0].length >= TITLE_MIN_FIRST_USER_CHARS ||
    userTexts[userTexts.length - 1].length >= TITLE_MIN_FIRST_USER_CHARS
  ) {
    return true;
  }

  const totalUser = userTexts.reduce((n, t) => n + t.length, 0);
  const hasAssistant = session.messages.some((m) => m.role === 'assistant' && messageText(m));
  return hasAssistant && totalUser >= TITLE_MIN_TOTAL_USER_CHARS;
}

/**
 * 是否应尝试更新标题（尊重手动重命名与已生成有效 auto）。
 *
 * @param meta - 会话元数据
 * @returns true = 允许写入 snippet 或重新生成 auto
 */
export function shouldUpdateTitle(meta: Pick<SessionMeta, 'title' | 'titleSource'>): boolean {
  if (meta.titleSource === 'user') return false;
  // 有效 auto 不再覆盖；「你好」这类弱 auto/snippet 仍可升级
  if (meta.titleSource === 'auto' && meta.title && !isWeakTitle(meta.title)) return false;
  return true;
}

/**
 * 构建临时标题：优先首条「有语义」的用户消息，否则取最长一条。
 *
 * 避免「你好」占位后复杂提问也一直显示「你好」。
 *
 * @param messages - 会话消息
 * @returns 截断后的 snippet；无有效用户消息时返回 null
 */
export function buildSnippetTitle(messages: Message[]): string | null {
  const userTexts = collectTitleUserTexts(messages);
  if (userTexts.length === 0) return null;
  const substantial = userTexts.find((t) => t.length >= TITLE_MIN_FIRST_USER_CHARS);
  const preferred = substantial
    ?? userTexts.reduce((a, b) => (b.length > a.length ? b : a));
  if (preferred.length <= TITLE_SNIPPET_MAX_CHARS) return preferred;
  return `${preferred.slice(0, TITLE_SNIPPET_MAX_CHARS - 1)}…`;
}

/**
 * 规范化模型输出的标题（去引号/换行、限长）。
 *
 * @param raw - 模型原始输出
 * @returns 单行短标题；空输出返回 null
 */
export function normalizeGeneratedTitle(raw: string): string | null {
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0] ?? '';
  let t = firstLine
    .replace(/^(?:["'「『]|&quot;)+/, '')
    .replace(/(?:["'」』]|&quot;)+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  if (t.length > TITLE_MAX_CHARS) t = `${t.slice(0, TITLE_MAX_CHARS - 1)}…`;
  return t;
}

/** 无信息量的寒暄（标题信号不足时仍可进 snippet，但不进摘要 prompt） */
const GREETING_ONLY_RE =
  /^(?:你好|您好|哈喽|hello|hi|hey|在吗|在么|早上好|中午好|下午好|晚上好|谢谢|感谢|好的|ok|okay|嗯|哦)[！!。～~.\s]*$/i;
/** 短问候回复，如「你好！有什么可以帮你？」 */
const PLEASANTRY_RE = /你好|您好|哈喽|hello|hi\b|帮你|有什么可以|请问需要|很高兴|欢迎/i;

function isNoiseForTitle(text: string): boolean {
  if (text.length < 4) return true;
  if (GREETING_ONLY_RE.test(text)) return true;
  return text.length <= 20 && PLEASANTRY_RE.test(text);
}

/**
 * 弱标题（寒暄/过短/无信息量）——即使已标成 auto 也允许再升级。
 *
 * @param title - 当前标题
 * @returns true = 不应视为最终摘要标题
 */
export function isWeakTitle(title: string | undefined): boolean {
  if (!title) return true;
  const t = title.trim();
  if (!t) return true;
  return isNoiseForTitle(t);
}

/**
 * 构建摘要标题的 LLM 消息。
 *
 * 标题语义 = 「这段对话面向的是什么事」（主题标签），不是对话内容复述。
 *
 * @param messages - 会话消息（跳过寒暄与命令留痕）
 * @returns 送给 ModelProvider.chat 的 messages
 */
export function buildTitlePrompt(messages: Message[]): Array<{ role: 'system' | 'user'; content: string }> {
  const entries: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const kind = msg.metadata?.kind;
    if (kind === 'command' || kind === 'command_result') continue;
    const text = messageText(msg);
    if (!text) continue;
    entries.push({ role: msg.role === 'user' ? 'user' : 'assistant', text });
  }

  // 有实质内容时丢掉纯寒暄，避免标题被「你好」带偏
  const meaningful = entries.filter((e) => !isNoiseForTitle(e.text));
  const picked = meaningful.length > 0 ? meaningful : entries;

  const lines = picked.slice(0, 6).map(
    (e) => `${e.role === 'user' ? '用户' : '助手'}: ${e.text.slice(0, 400)}`,
  );
  const dialogue = lines.join('\n');

  return [
    {
      role: 'system',
      content:
        '你是会话标题生成器。判断这段对话「面向的是什么事」，输出一个主题式短标题。\n' +
        '写法：像文件名/标签，点明对象+事项，优先保留专名（项目名、系统名、模块名、文档名）。\n' +
        '使用与对话相同的语言。6–16 个字为宜，不超过 20 字。\n' +
        '不要引号、不要句号、不要解释，只输出标题本身。',
    },
    { role: 'user', content: dialogue },
  ];
}
