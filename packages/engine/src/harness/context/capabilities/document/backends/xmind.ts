/**
 * XMind 后端 — ZIP + content.json / content.xml → Markdown 大纲
 *
 * XMind 2020+：content.json 树（children.attached）
 * XMind 8：content.xml topic 树（尽力解析）
 *
 * @module harness/context/capabilities/document/backends/xmind
 */

import { DocumentExtractError } from '../errors.js';
import type {
  DocumentExtractBackend,
  ExtractOptions,
  ExtractResult,
  ResolvedExtractSource,
} from '../types.js';

type FflateModule = {
  unzipSync: (data: Uint8Array) => Record<string, Uint8Array>;
  strFromU8: (data: Uint8Array) => string;
};

let fflateCache: FflateModule | null | undefined;

async function loadFflate(): Promise<FflateModule | null> {
  if (fflateCache !== undefined) return fflateCache;
  try {
    const mod = (await import('fflate')) as unknown as FflateModule;
    if (typeof mod.unzipSync !== 'function' || typeof mod.strFromU8 !== 'function') {
      fflateCache = null;
      return null;
    }
    fflateCache = mod;
    return mod;
  } catch {
    // 可选依赖未安装 —— 缓存 null，调用方走 BACKEND_UNAVAILABLE
    fflateCache = null;
    return null;
  }
}

interface XmindTopic {
  title?: string;
  note?: string | { plain?: string };
  href?: string;
  labels?: string[];
  children?: { attached?: XmindTopic[] };
}

function topicTitle(t: XmindTopic): string {
  return (t.title ?? '').trim() || '(untitled)';
}

function topicNote(t: XmindTopic): string {
  const n = t.note;
  if (!n) return '';
  const text = typeof n === 'string' ? n : (n.plain ?? '');
  return text.trim().replace(/\s+/g, ' ');
}

function walkTopics(topics: XmindTopic[], depth: number, out: string[]): void {
  for (const topic of topics) {
    const indent = '  '.repeat(depth);
    const note = topicNote(topic);
    const href = topic.href?.trim();
    const labels = (topic.labels ?? []).filter(Boolean).join(' ');
    const extras = [
      labels ? `[${labels}]` : '',
      href ? `<${href}>` : '',
      note ? `（${note}）` : '',
    ]
      .filter(Boolean)
      .join(' ');
    out.push(`${indent}- ${topicTitle(topic)}${extras ? ` ${extras}` : ''}`);
    const kids = topic.children?.attached ?? [];
    if (kids.length) walkTopics(kids, depth + 1, out);
  }
}

/** content.json（XMind 2020+）→ Markdown 大纲 */
export function xmindJsonToMarkdown(jsonText: string): string {
  let sheets: unknown;
  try {
    sheets = JSON.parse(jsonText);
  } catch (err) {
    throw new DocumentExtractError(
      'INVALID_SOURCE',
      `xmind content.json parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const list = Array.isArray(sheets) ? sheets : [sheets];
  const parts: string[] = [];
  for (const sheetRaw of list) {
    const sheet = sheetRaw as {
      title?: string;
      rootTopic?: XmindTopic;
    };
    const root = sheet.rootTopic;
    if (!root) continue;
    const sheetTitle = (sheet.title ?? '').trim();
    const lines: string[] = [];
    // 根主题作 H1；子主题作嵌套列表
    lines.push(`# ${topicTitle(root)}`);
    const note = topicNote(root);
    if (note) lines.push(`> ${note}`);
    lines.push('');
    walkTopics(root.children?.attached ?? [], 0, lines);
    if (sheetTitle && sheetTitle !== topicTitle(root)) {
      parts.push(`## ${sheetTitle}\n\n${lines.join('\n')}`);
    } else {
      parts.push(lines.join('\n'));
    }
  }
  return parts.join('\n\n').trim();
}

/**
 * content.xml（XMind 8）→ Markdown 大纲
 * 仅取 title 树，不解析样式/关系边。
 *
 * @param xmlText - content.xml 文本
 * @returns Markdown 大纲
 */
export function xmindXmlToMarkdown(xmlText: string): string {
  const cleaned = xmlText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?xml[\s\S]*?\?>/g, '');
  const nodes: Array<{ title: string; depth: number }> = [];
  let depth = 0;
  let guard = 0;
  const tokenRe = /<\/?topic\b[^>]*>|<title[^>]*>([\s\S]*?)<\/title>/gi;
  let t: RegExpExecArray | null;
  while ((t = tokenRe.exec(cleaned)) !== null) {
    guard += 1;
    if (guard > 50_000) break;
    const tok = t[0];
    if (/^<topic\b/i.test(tok)) {
      depth += 1;
    } else if (/^<\/topic>/i.test(tok)) {
      depth = Math.max(0, depth - 1);
    } else {
      const title = (t[1] ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      if (title) nodes.push({ title, depth: Math.max(0, depth - 1) });
    }
  }
  if (!nodes.length) {
    throw new DocumentExtractError('INVALID_SOURCE', 'xmind content.xml has no topics');
  }
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.depth === 0) {
      lines.push(`# ${node.title}`);
      lines.push('');
    } else {
      lines.push(`${'  '.repeat(node.depth - 1)}- ${node.title}`);
    }
  }
  return lines.join('\n').trim();
}

export const xmindBackend: DocumentExtractBackend = {
  id: 'xmind',
  tier: 't0',
  formats: ['xmind'],
  async isAvailable() {
    return (await loadFflate()) !== null;
  },
  accepts({ format }) {
    return format === 'xmind';
  },
  async extract(source: ResolvedExtractSource, _options: ExtractOptions): Promise<ExtractResult> {
    const fflate = await loadFflate();
    if (!fflate) {
      throw new DocumentExtractError('BACKEND_UNAVAILABLE', 'fflate is not installed', [
        'optional:fflate',
      ]);
    }

    let files: Record<string, Uint8Array>;
    try {
      files = fflate.unzipSync(source.data);
    } catch (err) {
      throw new DocumentExtractError(
        'INVALID_SOURCE',
        `xmind unzip failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const jsonEntry = files['content.json'];
    if (jsonEntry) {
      const markdown = xmindJsonToMarkdown(fflate.strFromU8(jsonEntry));
      return {
        markdown,
        meta: { format: 'xmind' },
        warnings: [],
        backend: 'xmind',
      };
    }

    const xmlEntry = files['content.xml'];
    if (xmlEntry) {
      const markdown = xmindXmlToMarkdown(fflate.strFromU8(xmlEntry));
      return {
        markdown,
        meta: { format: 'xmind' },
        warnings: [
          {
            code: 'DEGRADED_BACKEND',
            message: 'xmind content.json missing; parsed content.xml (XMind 8 path)',
          },
        ],
        backend: 'xmind',
      };
    }

    throw new DocumentExtractError('INVALID_SOURCE', 'xmind archive has no content.json/content.xml');
  },
};
