/**
 * DOCX HTML → Markdown 轻量转换（配合 mammoth 输出）
 *
 * 只覆盖 mammoth 常见语义标签，不引入 turndown 依赖。
 *
 * @module harness/context/capabilities/document/html-to-md
 */

/**
 * 将 mammoth 语义 HTML 片段转为 Markdown
 *
 * @param html - HTML fragment
 * @returns Markdown 文本
 */
export function htmlFragmentToMarkdown(html: string): string {
  let s = html;

  // 表格：先整表处理，避免单元格内标签被过早替换
  s = s.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => tableToMarkdown(table));

  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');

  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, inner) => {
    const text = inlineToMarkdown(inner).trim();
    return `\n\n${'#'.repeat(Number(level))} ${text}\n\n`;
  });

  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_m, inner) => {
    const text = inlineToMarkdown(inner).trim();
    return text ? `\n\n${text}\n\n` : '\n\n';
  });

  // 列表
  s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_m, inner) => listToMarkdown(inner, false));
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner) => listToMarkdown(inner, true));

  s = inlineToMarkdown(s);
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function inlineToMarkdown(input: string): string {
  let s = input;
  s = s.replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  s = s.replace(/<b\b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  s = s.replace(/<em\b[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  s = s.replace(/<i\b[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  s = s.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, '![$1]');
  s = s.replace(/<img\b[^>]*>/gi, '');
  // 去掉剩余标签，保留文本
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return s;
}

function listToMarkdown(inner: string, ordered: boolean): string {
  const items: string[] = [];
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(inner)) !== null) {
    n += 1;
    const text = inlineToMarkdown(m[1]).trim().replace(/\n+/g, ' ');
    items.push(ordered ? `${n}. ${text}` : `- ${text}`);
  }
  return `\n\n${items.join('\n')}\n\n`;
}

function tableToMarkdown(table: string): string {
  const rows: string[][] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(table)) !== null) {
    const cells: string[] = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1])) !== null) {
      cells.push(inlineToMarkdown(cm[1]).trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|'));
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return '\n\n';
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => {
    const copy = [...r];
    while (copy.length < width) copy.push('');
    return copy;
  });
  const lines = [
    `| ${norm[0].join(' | ')} |`,
    `| ${norm[0].map(() => '---').join(' | ')} |`,
    ...norm.slice(1).map((r) => `| ${r.join(' | ')} |`),
  ];
  return `\n\n${lines.join('\n')}\n\n`;
}
