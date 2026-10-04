/**
 * extractDocumentInWorker — 线程内文档抽取 + 可终止超时/中止
 */
import { Worker } from 'node:worker_threads';
import type { ExtractResult } from '../context/capabilities/document/types.js';

export interface DocumentExtractWorkerOptions {
  /** 抽取超时（默认 60s；到点 terminate worker） */
  timeoutMs?: number;
  maxFileBytes?: number;
  /** 中止信号：abort 时立刻 terminate worker */
  signal?: AbortSignal;
  /** 部分抽取限额（xlsx/pdf/text） */
  maxSheets?: number;
  maxRowsPerSheet?: number;
  maxPages?: number;
  maxTextChars?: number;
}

/**
 * 在 worker 线程抽取文档为 Markdown。
 *
 * @param filePath - 本地文件路径
 * @param options - 超时 / 大小 / 中止 / 部分抽取限额
 * @returns ExtractResult
 * @throws Error 超时 / abort / worker 失败 / 抽取错误
 */
export function extractDocumentInWorker(
  filePath: string,
  options: DocumentExtractWorkerOptions = {},
): Promise<ExtractResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('extract_aborted'));
      return;
    }
    let settled = false;
    const worker = new Worker(new URL('./document-extract-worker.js', import.meta.url), {
      workerData: {
        path: filePath,
        name: filePath,
        timeoutMs,
        maxFileBytes: options.maxFileBytes,
        maxSheets: options.maxSheets,
        maxRowsPerSheet: options.maxRowsPerSheet,
        maxPages: options.maxPages,
        maxTextChars: options.maxTextChars,
      },
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      fn();
    };
    const onAbort = () => {
      finish(() => reject(new Error('extract_aborted')));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`extract_worker_timeout after ${timeoutMs}ms`)));
    }, timeoutMs);

    worker.on('message', (msg: { ok: boolean; result?: ExtractResult; error?: string }) => {
      if (msg?.ok && msg.result) {
        finish(() => resolve(msg.result!));
      } else {
        finish(() => reject(new Error(msg?.error || 'extract_worker_failed')));
      }
    });
    worker.on('error', (err) => {
      finish(() => reject(err));
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        finish(() => reject(new Error(`extract_worker_exit ${code}`)));
      }
    });
  });
}
