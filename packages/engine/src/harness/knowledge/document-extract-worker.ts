/**
 * Document extract worker — 在独立线程跑同步 Office/SheetJS 抽取
 *
 * 避免 xlsx.read 等同步实现堵死主事件循环。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createDefaultDocumentPort } from '../context/capabilities/document/port.js';

interface WorkerJob {
  path: string;
  name?: string;
  timeoutMs?: number;
  maxFileBytes?: number;
  maxSheets?: number;
  maxRowsPerSheet?: number;
  maxPages?: number;
  maxTextChars?: number;
}

async function main(): Promise<void> {
  const job = workerData as WorkerJob;
  const port = createDefaultDocumentPort({
    config: {
      enabled: true,
      timeoutMs: job.timeoutMs ?? 60_000,
      maxFileBytes: job.maxFileBytes ?? 50 * 1024 * 1024,
    },
  });
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
  parentPort?.postMessage({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
});
