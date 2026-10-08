/**
 * parseTextInWorker — 文本/MD/代码 读盘+hash+切块+FTS token 的线程入口
 *
 * 与 document extract worker 同一原则：CPU 密集步骤不得占 Service/Gateway 事件循环。
 */
import { Worker } from 'node:worker_threads';
import type { KnowledgeChunkDraft } from './adapters.js';
import { resolveWorkerUrl } from '../../worker-path.js';

export interface TextParseWorkerOptions {
  /** 部分抽取时的截断阈值 */
  maxTextChars?: number;
  sizeDecision?: 'ok' | 'partial';
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 文本 worker 并发上限（默认 4；轻于 SheetJS） */
  concurrency?: number;
}

export interface TextParseResult {
  contentHash: string;
  contentLength: number;
  adapterId: string;
  chunks: KnowledgeChunkDraft[];
}

const DEFAULT_TEXT_CONCURRENCY = 4;
let textInFlight = 0;
const textWaiters: Array<() => void> = [];

/**
 * 槽位移交式信号量：release 唤醒 waiter 时 **不减计数**（槽交给对方），
 * 避免「减后再 +」窗口被第三方 acquire 插队导致超卖。
 */
async function acquireTextSlot(max: number): Promise<void> {
  if (textInFlight < max) {
    textInFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => textWaiters.push(resolve));
}

function releaseTextSlot(): void {
  const next = textWaiters.shift();
  if (next) {
    next();
    return;
  }
  textInFlight = Math.max(0, textInFlight - 1);
}

/**
 * 在 worker 中完成文本文件的 hash + 切块 + FTS token。
 *
 * @param filePath - 本地文件路径
 * @param options - 截断策略 / 超时 / 中止 / 并发
 * @returns contentHash + chunks（含 ftsToks）
 */
/**
 * 已有文本内容的切块 + ftsToks（虚拟文档 / DocumentPort 回退）。
 *
 * @param text - UTF-8 文本
 * @param path - 用于 adapter 启发式与 FTS 路径 token
 * @returns chunks（含 ftsToks）
 */
export function chunkTextWithFtsToks(
  text: string,
  path: string,
  signal?: AbortSignal,
  adapterId?: string,
  timeoutMs = 60_000,
): Promise<KnowledgeChunkDraft[]> {
  return (async () => {
    await acquireTextSlot(DEFAULT_TEXT_CONCURRENCY);
    try {
      return await new Promise<KnowledgeChunkDraft[]>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('parse_aborted'));
          return;
        }
        let settled = false;
        const worker = new Worker(resolveWorkerUrl('./text-parse-worker.js', import.meta.url), {
          workerData: {
            inlineText: text,
            path,
            adapterId,
            sizeDecision: 'ok',
          },
        });
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          void worker.terminate();
          fn();
        };
        const onAbort = () => finish(() => reject(new Error('parse_aborted')));
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => {
          finish(() => reject(new Error(`text_parse_timeout after ${timeoutMs}ms`)));
        }, timeoutMs);
        worker.on(
          'message',
          (msg: { ok: boolean; chunks?: KnowledgeChunkDraft[]; error?: { message?: string } }) => {
            if (msg?.ok && msg.chunks) {
              finish(() => resolve(msg.chunks!));
            } else {
              finish(() => reject(new Error(msg?.error?.message ?? 'text_parse_failed')));
            }
          },
        );
        worker.on('error', (err) => finish(() => reject(err)));
        worker.on('exit', (code) => {
          if (code !== 0) finish(() => reject(new Error(`text_parse_worker_exit ${code}`)));
        });
      });
    } finally {
      releaseTextSlot();
    }
  })();
}

export function parseTextInWorker(
  filePath: string,
  options: TextParseWorkerOptions = {},
): Promise<TextParseResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const max = options.concurrency ?? DEFAULT_TEXT_CONCURRENCY;
  return (async () => {
    await acquireTextSlot(max);
    try {
      return await new Promise<TextParseResult>((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('parse_aborted'));
          return;
        }
        let settled = false;
        const worker = new Worker(resolveWorkerUrl('./text-parse-worker.js', import.meta.url), {
          workerData: {
            path: filePath,
            sizeDecision: options.sizeDecision ?? 'ok',
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
          finish(() => reject(new Error('parse_aborted')));
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => {
          finish(() => reject(new Error(`text_parse_timeout after ${timeoutMs}ms`)));
        }, timeoutMs);

        worker.on(
          'message',
          (msg: {
            ok: boolean;
            contentHash?: string;
            contentLength?: number;
            adapterId?: string;
            chunks?: KnowledgeChunkDraft[];
            error?: { message?: string };
          }) => {
            if (msg?.ok && msg.contentHash && msg.chunks && msg.adapterId) {
              finish(() =>
                resolve({
                  contentHash: msg.contentHash!,
                  contentLength: msg.contentLength ?? 0,
                  adapterId: msg.adapterId!,
                  chunks: msg.chunks!,
                }),
              );
            } else {
              finish(() => reject(new Error(msg?.error?.message ?? 'text_parse_failed')));
            }
          },
        );
        worker.on('error', (err) => {
          finish(() => reject(err));
        });
        worker.on('exit', (code) => {
          if (code !== 0) {
            finish(() => reject(new Error(`text_parse_worker_exit ${code}`)));
          }
        });
      });
    } finally {
      releaseTextSlot();
    }
  })();
}
