/**
 * 会话标题策略 — 临时截断 / 小模型摘要触发条件
 *
 * 目标：历史列表一眼可认；「你好」类碎消息不浪费 LLM 调用。
 */

import type { Message, SessionMeta } from '@octopi-agent/core/types.js';
import { extractUserMessageText } from '../context/turn-envelope.js';
import { isUserAuthoredMessage } from '../context/layer-types.js';
import type { SessionData } from './types.js';

/** 首条有效用户消息达到该长度才可直接摘要 */
export const TITLE_MIN_FIRST_USER_CHARS = 16;
/** 累计有效用户内容达到该长度（且至少 1 轮完成）可摘要 */
export const TITLE_MIN_TOTAL_USER_CHARS = 40;
/** 临时截断标题最大长度 */
export const TITLE_SNIPPET_MAX_CHARS = 24;
/** 生成标题最大长度 */
export const TITLE_MAX_CHARS = 40;

/** 参与标题信号统计的用户消息（排除 slash 命令留痕与机器插槽；唯一谓词在 layer-types） */
function isTitleRelevantUserMessage(msg: Message): boolean {
  if (!isUserAuthoredMessage(msg)) return false;
  const kind = msg.metadata?.kind;
  if (kind === 'command' || kind === 'command_result') return false;
  return true;
}

/**
 * 提取纯文本并压空白。
 *
 * f126dc9 后真实用户消息的 content 是 `<turn_start>` 整封（含 turn_context
 * 快照/grounding）：必须解包取 `<user_message>` 原文，否则标题信号被信封
 * boilerplate 吃满、snippet 被信封形状误判为载荷（OP-WEB-5② 残留）。
 * 非信封正文（assistant / 载体 / 便签）原样返回。
 */
function messageText(msg: Message): string {
  return extractUserMessageText(msg.content).replace(/\s+/g, ' ').trim();
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // 非法 percent-encoding 原样返回，不因个别字符丢掉整段
    return s;
  }
}

/** 从 URL / 路径 token 取文件名（尽量解码 percent-encoding） */
function filenameFromUrlLike(token: string): string {
  const withoutScheme = token.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const withoutDrive = withoutScheme.replace(/^[A-Za-z]:[\\/]?/, '');
  const last = withoutDrive.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const base = last.split(/[?#]/)[0] ?? '';
  const decoded = safeDecodeURIComponent(base).trim();
  if (!decoded) return '路径';
  return decoded.length > 40 ? `${decoded.slice(0, 39)}…` : decoded;
}

/**
 * 压缩 URL / 本地路径，避免路径噪声占满 snippet 与摘要 prompt。
 *
 * 长 percent-encoded file:// 路径会把 24 字 snippet 截成「帮我评估一下， file:///…」，
 * 也会把送入小模型的前 400 字预算吃光，导致摘要失败或弱标题。
 *
 * @param text - 原始消息文本
 * @returns 路径替换为文件名后的文本
 */
export function compactTitleText(text: string): string {
  return text
    .replace(/\b(?:file|https?):\/\/[^\s<>"']+/gi, (m) => filenameFromUrlLike(m))
    .replace(/\b[A-Za-z]:[\\/][^\s<>"']+/g, (m) => filenameFromUrlLike(m))
    .replace(/(?:^|[\s（(「『])((?:\/[\w.@-]+){2,})/g, (m, path: string) => {
      const lead = m.slice(0, m.length - path.length);
      return `${lead}${filenameFromUrlLike(path)}`;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** 标题用文本：纯文本 + 路径压缩 */
function titleText(msg: Message): string {
  return compactTitleText(messageText(msg));
}

/** 收集标题相关的用户文本（按时间序，已压缩路径） */
export function collectTitleUserTexts(messages: Message[]): string[] {
  return messages.filter(isTitleRelevantUserMessage).map(titleText).filter(Boolean);
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
 * 是否像代码 / 标记 / 工具载荷——不适合当会话标题。
 *
 * 只拦「本身就是载荷」的开头，不误伤「npm 依赖冲突」这类正常主题。
 *
 * @param text - 候选标题或消息正文
 * @returns true = 应跳过或视为弱标题
 */
export function looksLikeCodeOrMarkup(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // XML/HTML/自定义标签开头（含 </…>、<!…>、<?…>）
  if (/^<[a-zA-Z!?/]/.test(t)) return true;
  // 被转义的尖括号标签
  if (/^(?:&lt;|&#60;)/i.test(t)) return true;
  // 完整 JSON / 配置块
  if (t.length > 20 && /^[{[][\s\S]*[}\]]$/.test(t)) return true;
  return false;
}

/** 是否几乎只是路径 / URL / percent-encoding 堆叠 */
function isPathDominated(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^(?:file|https?):\/\//i.test(t)) return true;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (t.startsWith('/')) return true;
  // percent-encoding 占比过高：解码后语义信息量不足
  const stripped = t.replace(/%[0-9A-Fa-f]{2}/g, '');
  if (t.length >= 12 && stripped.length < t.length * 0.4) return true;
  // 纯 ASCII 文件名（无语义词），如 report.pdf / data.json
  if (/^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(t)) return true;
  return false;
}

/** 开场客套前缀——截断前去掉，让 snippet 落在事项上 */
const LEAD_IN_RE = /^(?:请|麻烦|帮我|给我|帮忙|能不能|可不可以|想请你|请问|你好[，,]?\s*)+/;

/**
 * 构建临时标题：优先首条「有语义」的用户消息，否则取最长一条。
 *
 * 避免「你好」占位后复杂提问也一直显示「你好」；路径已压缩为文件名。
 *
 * @param messages - 会话消息
 * @returns 截断后的 snippet；无有效用户消息时返回 null
 */
export function buildSnippetTitle(messages: Message[]): string | null {
  const userTexts = collectTitleUserTexts(messages)
    .map((t) => t.replace(LEAD_IN_RE, '').trim() || t)
    .filter((t) => !looksLikeCodeOrMarkup(t) && !isPathDominated(t));
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
  // 去掉一层简单包裹标签，如 <title>xxx</title>
  t = t.replace(/^<([a-zA-Z][\w:-]*)[^>]*>([\s\S]*)<\/\1>$/, '$2').trim();
  if (!t) return null;
  if (looksLikeCodeOrMarkup(t)) return null;
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
  if (looksLikeCodeOrMarkup(t)) return true;
  if (isPathDominated(t)) return true;
  return isNoiseForTitle(t);
}

/**
 * 构建摘要标题的 LLM 消息。
 *
 * 标题语义 = 「这段对话面向的是什么事」（主题标签），不是对话内容复述。
 * 正文先压缩 URL/路径，避免 percent-encoded 路径吃光上下文预算。
 *
 * @param messages - 会话消息（跳过寒暄与命令留痕）
 * @returns 送给 ModelProvider.chat 的 messages
 */
export function buildTitlePrompt(messages: Message[]): Array<{ role: 'system' | 'user'; content: string }> {
  const entries: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      // 用户侧复用唯一谓词（载体/命令留痕过滤单源）
      if (!isTitleRelevantUserMessage(msg)) continue;
    } else if (msg.role === 'assistant') {
      const kind = msg.metadata?.kind;
      if (kind === 'command' || kind === 'command_result') continue;
    } else {
      continue;
    }
    const text = titleText(msg);
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
        '忽略路径、URL、命令行等载荷噪音，标题写实际要做的事。\n' +
        '使用与对话相同的语言。6–16 个字为宜，不超过 20 字。\n' +
        '不要引号、不要句号、不要解释，只输出标题本身。',
    },
    { role: 'user', content: dialogue },
  ];
}
