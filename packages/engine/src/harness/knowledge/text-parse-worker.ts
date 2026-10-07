/**
 * Text parse worker — 读盘 + hash + 切块 + FTS token 全在独立线程
 *
 * 主线程/Service 事件循环不得做多 MB 文本的 CPU 切块与 CJK 二元组。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  FormatAdapterRegistry,
  htmlAdapter,
  markdownAdapter,
  textAdapter,
  type FormatAdapter,
  type KnowledgeChunkDraft,
} from './adapters.js';
import { buildFtsTokens } from './fts.js';

interface TextParseJob {
  path: string;
  /** 直接给文本（虚拟文档）；与 path 读盘二选一 */
  inlineText?: string;
  /** 调用方已选定的 adapter id（虚拟文档无扩展名时必给） */
  adapterId?: string;
  /** 'ok' = 全量；'partial' = 截断到 maxTextChars */
  sizeDecision: 'ok' | 'partial';
  maxTextChars?: number;
}

function adapterById(id: string | undefined): FormatAdapter | null {
  if (id === 'html') return htmlAdapter;
  if (id === 'markdown') return markdownAdapter;
  if (id === 'text') return textAdapter;
  return null;
}

async function main(): Promise<void> {
  const job = workerData as TextParseJob;
  const content = job.inlineText != null ? job.inlineText : await readFile(job.path, 'utf8');
  const contentHash = createHash('sha256').update(content).digest('hex');
  const registry = new FormatAdapterRegistry();
  let adapter = registry.match(job.path) ?? adapterById(job.adapterId);
  if (!adapter) {
    // 虚拟文档常无扩展名：退 text，而不是整源 no_adapter
    adapter = textAdapter;
  }
  const maxTextChars = job.maxTextChars ?? 2_000_000;
  const text =
    job.sizeDecision === 'partial' && content.length > maxTextChars
      ? `${content.slice(0, maxTextChars)}\n\ntruncated: ${content.length - maxTextChars} chars omitted]`
      : content;
  const chunks: KnowledgeChunkDraft[] = adapter.chunk(text, job.path);
  for (const c of chunks) {
    c.ftsToks = buildFtsTokens(c.text, job.path);
  }
  parentPort?.postMessage({
    ok: true,
    contentHash,
    contentLength: content.length,
    adapterId: adapter.id,
    chunks,
  });
}

main().catch((err: unknown) => {
  parentPort?.postMessage({
    ok: false,
    error: {
      name: err instanceof Error ? err.name : 'Error',
      message: err instanceof Error ? err.message : String(err),
    },
  });
});
