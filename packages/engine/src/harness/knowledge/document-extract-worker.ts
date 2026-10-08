/**
 * Document extract worker — 在独立线程跑同步 Office/SheetJS 抽取 + 切块 + FTS token
 *
 * 避免 xlsx.read / 切块 / CJK 滑窗堵死 Service 事件循环。
 * 装配走 createDocumentPortFromConfig：与 Gateway 共用 documents.* 单源。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  createDocumentPortFromConfig,
  type DocumentCapabilityConfig,
} from '../capabilities/document/factory.js';
import { DocumentExtractError } from '../capabilities/document/errors.js';
import { markdownAdapter, type KnowledgeChunkDraft } from './adapters.js';
import { buildFtsTokens } from './fts.js';

/** 流式 SHA-256：不在 Engine/本 worker 一次性吞下整文件 Buffer */
async function hashFileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => resolve());
    stream.once('error', reject);
  });
  return hash.digest('hex');
}

interface WorkerJob {
  path: string;
  name?: string;
  timeoutMs?: number;
  maxFileBytes?: number;
  maxSheets?: number;
  maxRowsPerSheet?: number;
  maxPages?: number;
  maxTextChars?: number;
  /** documents.* 根配置（与 Gateway 同源） */
  documentConfig?: DocumentCapabilityConfig | null;
}

async function main(): Promise<void> {
  const job = workerData as WorkerJob;
  const port = createDocumentPortFromConfig(job.documentConfig);
  const result = await port.extract(
    { path: job.path, name: job.name ?? job.path },
    {
      timeoutMs: job.timeoutMs ?? 60_000,
      maxFileBytes: job.maxFileBytes,
      maxSheets: job.maxSheets,
      maxRowsPerSheet: job.maxRowsPerSheet,
      maxPages: job.maxPages,
      maxTextChars: job.maxTextChars,
    },
  );
  const markdown = result.markdown?.trim() ?? '';
  let chunks: KnowledgeChunkDraft[] = [];
  if (markdown) {
    chunks = markdownAdapter.chunk(markdown, job.path);
    for (const c of chunks) {
      c.ftsToks = buildFtsTokens(c.text, job.path);
    }
  }
  const contentHash = await hashFileSha256(job.path);
  parentPort?.postMessage({ ok: true, result, chunks, contentHash });
}

main().catch((err: unknown) => {
  // 结构化错误必须跨 postMessage 存活：父进程 instanceof 会丢
  if (err instanceof DocumentExtractError) {
    parentPort?.postMessage({
      ok: false,
      error: {
        name: 'DocumentExtractError',
        code: err.code,
        message: err.message,
        requires: err.requires,
      },
    });
    return;
  }
  parentPort?.postMessage({
    ok: false,
    error: {
      name: err instanceof Error ? err.name : 'Error',
      message: err instanceof Error ? err.message : String(err),
    },
  });
});
