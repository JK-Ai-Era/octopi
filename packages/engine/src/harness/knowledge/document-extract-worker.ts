/**
 * Document extract worker — 在独立线程跑同步 Office/SheetJS 抽取
 *
 * 避免 xlsx.read 等同步实现堵死主事件循环。
 * 装配走 createDocumentPortFromConfig：与 Gateway 共用 documents.* 单源。
 */
import { parentPort, workerData } from 'node:worker_threads';
import {
  createDocumentPortFromConfig,
  type DocumentCapabilityConfig,
} from '../capabilities/document/factory.js';
import { DocumentExtractError } from '../capabilities/document/errors.js';

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
  parentPort?.postMessage({ ok: true, result });
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
