/**
 * WorkerDocumentPort — DocumentPort.extract 走独立线程
 *
 * Gateway 侧 attachments / document_read 用本包装：SheetJS 同步解析不得占主事件循环。
 * 实现复用 knowledge 的 extractDocumentInWorker（单条 worker 抽取路径）。
 */
import { extractDocumentInWorker } from '../../knowledge/extract-document.js';
import { createDocumentPortFromConfig } from './factory.js';
import type {
  DocumentCapabilities,
  DocumentPort,
  ExtractOptions,
  ExtractResult,
  ExtractSource,
  ProbeResult,
} from './types.js';
import type { DocumentCapabilityConfig } from './factory.js';

const DEFAULT_CONCURRENCY = 2;
let inFlight = 0;
const waiters: Array<() => void> = [];

/** 槽位移交：唤醒 waiter 时把槽交给对方，防止减后加窗口超卖 */
async function acquire(max: number): Promise<void> {
  if (inFlight < max) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  inFlight = Math.max(0, inFlight - 1);
}

/**
 * 创建 extract 走 worker 的 DocumentPort。
 *
 * @param options.documentConfig - documents.* 根配置
 * @param options.concurrency - 并发 worker 上限（默认 2）
 * @returns DocumentPort（probe/capabilities 仍进程内，轻量）
 */
export function createWorkerDocumentPort(options?: {
  documentConfig?: DocumentCapabilityConfig | null;
  concurrency?: number;
}): DocumentPort {
  const inner = createDocumentPortFromConfig(options?.documentConfig ?? null);
  const max = options?.concurrency ?? DEFAULT_CONCURRENCY;

  return {
    async extract(source: ExtractSource, extractOptions?: ExtractOptions): Promise<ExtractResult> {
      if (source.data) {
        // 内联 buffer：仍经工厂进程内抽（无路径可开 worker；保持 DocumentPort 契约）
        return inner.extract(source, extractOptions);
      }
      if (!source.path) {
        return inner.extract(source, extractOptions);
      }
      await acquire(max);
      try {
        const { result } = await extractDocumentInWorker(source.path, {
          ...(extractOptions?.timeoutMs != null ? { timeoutMs: extractOptions.timeoutMs } : {}),
          ...(extractOptions?.maxFileBytes != null
            ? { maxFileBytes: extractOptions.maxFileBytes }
            : {}),
          ...(extractOptions?.maxSheets != null ? { maxSheets: extractOptions.maxSheets } : {}),
          ...(extractOptions?.maxRowsPerSheet != null
            ? { maxRowsPerSheet: extractOptions.maxRowsPerSheet }
            : {}),
          ...(extractOptions?.maxPages != null ? { maxPages: extractOptions.maxPages } : {}),
          ...(extractOptions?.maxTextChars != null
            ? { maxTextChars: extractOptions.maxTextChars }
            : {}),
          ...(extractOptions?.signal ? { signal: extractOptions.signal } : {}),
          documentConfig: options?.documentConfig ?? null,
        });
        return result;
      } finally {
        release();
      }
    },
    capabilities(): Promise<DocumentCapabilities> {
      return inner.capabilities();
    },
    probe(source: ExtractSource): Promise<ProbeResult> {
      return inner.probe(source);
    },
  };
}
