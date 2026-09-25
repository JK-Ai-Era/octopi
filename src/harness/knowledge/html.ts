/**
 * HTML 入站规范化 — 抽出可用正文，而不是 raw HTML 进 chunk
 *
 * 启发式：去脚本/样式/导航壳，保留 title、标题层级、段落/列表/代码。
 * 输出近 Markdown 纯文本，供 FormatAdapter 按结构切块。
 */

const DROP_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'canvas',
  'form',
  'nav',
  'footer',
  'header',
  'aside',
];

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/gi, '&');
}

/**
 * 从 HTML 提取结构化纯文本
 *
 * @param html - HTML 原文
 * @returns 近 Markdown 文本（title 作一级标题；无正文时可为空）
 */
export function htmlToStructuredText(html: string): string {
  if (!html?.trim()) return '';

  let work = html;
  for (const tag of DROP_TAGS) {
    work = work.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    work = work.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), ' ');
  }

  const titleMatch = work.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().replace(/\s+/g, ' ') : '';

  const mainMatch =
    work.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) ||
    work.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const bodyHtml = mainMatch ? mainMatch[1] : work;

  // 先把结构标签换成行边界，再剥其余标签
  let text = bodyHtml
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote|ul|ol|table)\s*>/gi, '\n')
    .replace(/<(h)([1-6])\b[^>]*>/gi, (_, _h: string, n: string) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<pre\b[^>]*>/gi, '\n```\n')
    .replace(/<\/pre\s*>/gi, '\n```\n')
    .replace(/<code\b[^>]*>/gi, '`')
    .replace(/<\/code\s*>/gi, '`')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n');

  text = decodeEntities(text);

  const lines = text
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim());

  const out: string[] = [];
  if (title) out.push(`# ${title}`);
  for (const line of lines) {
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    const plain = line.replace(/^#+\s*/, '').replace(/[`#]/g, '').trim();
    if (title && plain === title && out.length === 1) continue;
    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 判断内容是否像 HTML
 *
 * @param content - 文本内容
 * @param contentType - 可选 Content-Type
 */
export function looksLikeHtml(content: string, contentType?: string): boolean {
  if (contentType && /text\/html|application\/xhtml\+xml/i.test(contentType)) return true;
  const head = content.slice(0, 512).trim().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || /<html[\s>]/i.test(head);
}
