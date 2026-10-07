/**
 * extractDocumentInWorker — 线程内文档抽取 + 切块 + FTS token
 */
import { Worker } from 'node:worker_threads';
import { DocumentExtractError } from '../capabilities/document/errors.js';
import type { DocumentCapabilityConfig } from '../capabilities/document/factory.js';
import type { ExtractErrorCode, ExtractResult } from '../capabilities/document/types.js';
import type { KnowledgeChunkDraft } from './adapters.js';
import { resolveWorkerUrl } from '../../worker-path.js';

interface WorkerErrorPayload {
  name?: string;
  code?: string;
  message: string;
  requires?: string[];
}

/** postMessage 不保留 class 原型；按 name/code 还原 DocumentExtractError */
function rehydrateWorkerError(payload: unknown): Error {
  if (typeof payload === 'string') return new Error(payload);
  if (payload && typeof payload === 'object' && 'message' in payload) {
    const e = payload as WorkerErrorPayload;
    if (e.name === 'DocumentExtractError' && e.code) {
      return new DocumentExtractError(
        e.code as ExtractErrorCode,
        e.message,
        e.requires,
      );
    }
    return new Error(e.message);
  }
  return new Error('extract_worker_failed');
}

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
  /** documents.* 配置（与 Gateway 同源；含 legacy/soffice） */
  documentConfig?: DocumentCapabilityConfig | null;
}

export interface DocumentExtractWorkerResult {
  result: ExtractResult;
  /** 预计算 ftsToks 的切块（markdown 空时为空数组） */
  chunks: KnowledgeChunkDraft[];
}

/**
 * 在 worker 线程抽取文档为 Markdown，并完成切块 + FTS token。
 *
 * @param filePath - 本地文件路径
 * @param options - 超时 / 大小 / 中止 / 部分抽取限额
 * @returns ExtractResult + chunks
 * @throws Error 超时 / abort / worker 失败 / 抽取错误
 */
export function extractDocumentInWorker(
  filePath: string,
  options: DocumentExtractWorkerOptions = {},
): Promise<DocumentExtractWorkerResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('extract_aborted'));
      return;
    }
    let settled = false;
    const worker = new Worker(
      resolveWorkerUrl('./document-extract-worker.js', import.meta.url),
      {
        workerData: {
          path: filePath,
          name: filePath,
          timeoutMs,
          maxFileBytes: options.maxFileBytes,
          maxSheets: options.maxSheets,
          maxRowsPerSheet: options.maxRowsPerSheet,
          maxPages: options.maxPages,
          maxTextChars: options.maxTextChars,
          documentConfig: options.documentConfig ?? null,
        },
      },
    );
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

    worker.on(
      'message',
      (msg: {
        ok: boolean;
        result?: ExtractResult;
        chunks?: KnowledgeChunkDraft[];
        error?: unknown;
      }) => {
        if (msg?.ok && msg.result) {
          finish(() =>
            resolve({ result: msg.result!, chunks: msg.chunks ?? [] }),
          );
        } else {
          finish(() => reject(rehydrateWorkerError(msg?.error)));
        }
      },
    );
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
