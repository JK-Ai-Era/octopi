/**
 * Engine Thread — Knowledge 业务 + SQLite + ingest 全在 Worker
 *
 * 主线程（serve.ts）只做 HTTP 转发。本线程允许阻塞（同步 node:sqlite、FTS、写库），
 * 但不得影响主线程 /health 与连接接受。
 *
 * 解析 CPU 仍用嵌套 worker_threads（extract / chunk / ftsToks）。
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { KnowledgeDatabase } from './db.js';
import { createKnowledgeHttpApp, type KnowledgeServiceToken } from './http-app.js';
import type { DocumentCapabilityConfig } from '../capabilities/document/factory.js';
import type { HttpBridgeRequest, HttpBridgeOutbound } from './http-bridge.js';

interface EngineBoot {
  dbPath: string;
  tokens: KnowledgeServiceToken[];
  autoRegisterPrincipals?: boolean;
  documentConfig?: DocumentCapabilityConfig | null;
  sqliteVecExtensionPath?: string;
  embeddingModels?: {
    providers?: Record<string, unknown>;
    embedding?: unknown;
  } | null;
  embed?: {
    enabled?: boolean;
    embedBatch?: number;
    embedMinIntervalMs?: number;
    embedConcurrency?: number;
    embedSecretPolicy?: 'allow' | 'redact' | 'skip';
  } | null;
  /** 测试用：确定性 stub embedding（不可序列化闭包从主线程传入） */
  testEmbeddingStub?: boolean;
}

type Out = (msg: HttpBridgeOutbound & { id?: number }) => void;

function createMockReq(dto: HttpBridgeRequest, onClose: (fn: () => void) => void): IncomingMessage {
  const closeHandlers: Array<() => void> = [];
  onClose(() => {
    for (const fn of closeHandlers) fn();
  });
  const req = {
    method: dto.method,
    url: dto.url,
    headers: dto.headers,
    on(event: string, fn: (...args: unknown[]) => void) {
      if (event === 'close') closeHandlers.push(fn as () => void);
      return req;
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      if (event === 'close') {
        const i = closeHandlers.indexOf(fn as () => void);
        if (i >= 0) closeHandlers.splice(i, 1);
      }
      return req;
    },
    async *[Symbol.asyncIterator]() {
      if (dto.body) yield Buffer.from(dto.body, 'utf8');
    },
  };
  return req as unknown as IncomingMessage;
}

function createMockRes(out: Out, id: number): ServerResponse & { __sse: boolean } {
  let status = 200;
  let headers: Record<string, string | number | string[]> = {};
  const chunks: string[] = [];
  let sse = false;
  let ended = false;
  let headEmitted = false;

  const emit = (msg: HttpBridgeOutbound) => out({ id, ...msg });

  const ensureHead = () => {
    if (headEmitted) return;
    headEmitted = true;
    emit({ type: 'sse-start', status, headers });
  };

  const res = {
    __sse: false,
    statusCode: status,
    writeHead(code: number, hdrs?: Record<string, string | number | string[]>) {
      status = code;
      if (hdrs) headers = { ...headers, ...hdrs };
      const ct = String(headers['content-type'] ?? '');
      sse = ct.includes('text/event-stream');
      (res as { __sse: boolean }).__sse = sse;
      if (sse) ensureHead();
      return res;
    },
    setHeader(name: string, value: string | number | string[]) {
      headers[name] = value;
      return res;
    },
    getHeader(name: string) {
      return headers[name];
    },
    write(chunk: unknown) {
      const s = typeof chunk === 'string' ? chunk : String(chunk);
      if (sse) {
        ensureHead();
        emit({ type: 'sse-write', chunk: s });
      } else {
        chunks.push(s);
      }
      return true;
    },
    end(chunk?: unknown) {
      if (ended) return res;
      if (chunk != null) res.write(chunk);
      ended = true;
      if (sse) emit({ type: 'sse-end' });
      else
        emit({
          type: 'end',
          status,
          headers: {
            ...headers,
            'content-length': Buffer.byteLength(chunks.join(''), 'utf8'),
          },
          body: chunks.join(''),
        });
      return res;
    },
    on() {
      return res;
    },
  };
  return res as unknown as ServerResponse & { __sse: boolean };
}

function stubEmbeddingProvider() {
  let n = 0;
  return {
    name: 'test-stub',
    dimensions: 4,
    async embed() {
      n += 1;
      return [n, 0.1, 0.2, 0.3];
    },
    async embedBatch(texts: string[]) {
      return texts.map((_, i) => [i + n, 0.1, 0.2, 0.3]);
    },
  };
}

async function main(): Promise<void> {
  const boot = workerData as EngineBoot;
  const db = await KnowledgeDatabase.create({
    dbPath: boot.dbPath,
    sqliteVec: boot.sqliteVecExtensionPath
      ? { extensionPath: boot.sqliteVecExtensionPath }
      : true,
  });

  let embeddingProvider: unknown = null;
  if (boot.testEmbeddingStub) {
    embeddingProvider = stubEmbeddingProvider();
  } else if (boot.embeddingModels && boot.embed?.enabled !== false) {
    const { resolveEmbeddingRuntime } = await import(
      '../memory/sqlite/embedding-from-models.js'
    );
    const runtime = resolveEmbeddingRuntime(
      boot.embeddingModels as Parameters<typeof resolveEmbeddingRuntime>[0],
    );
    embeddingProvider = runtime?.provider ?? null;
  }

  const app = createKnowledgeHttpApp({
    db,
    tokens: boot.tokens,
    autoRegisterPrincipals: boot.autoRegisterPrincipals ?? true,
    documentConfig: boot.documentConfig ?? null,
    embeddingProvider: embeddingProvider as never,
    embed: boot.embed ?? null,
  });
  app.startIngestRuntime();

  const port = parentPort;
  if (!port) throw new Error('knowledge engine thread requires parentPort');

  const out: Out = (msg) => port.postMessage(msg);
  // SSE：主线程客户端断开时通知本线程清理订阅
  const clientCloseByReq = new Map<number, () => void>();
  /** handle 尚未返回时到达的 client-close：标记后在 then 里立刻执行，避免监听泄漏 */
  const earlyClose = new Set<number>();

  port.on('message', (msg: { type?: string; id?: number; req?: HttpBridgeRequest }) => {
    if (msg?.type === 'http' && msg.id != null && msg.req) {
      const id = msg.id;
      let closeFn: () => void = () => undefined;
      let closeRegistered = false;
      const runClose = () => {
        if (!closeRegistered) {
          earlyClose.add(id);
          return;
        }
        const fn = clientCloseByReq.get(id);
        clientCloseByReq.delete(id);
        fn?.();
      };
      const req = createMockReq(msg.req, (fn) => {
        closeFn = fn;
      });
      const res = createMockRes(out, id);
      void app
        .handle(req, res)
        .then(() => {
          if (!res.__sse) return;
          clientCloseByReq.set(id, () => closeFn());
          closeRegistered = true;
          if (earlyClose.delete(id)) runClose();
        })
        .catch(() => {
          clientCloseByReq.delete(id);
          earlyClose.delete(id);
        });
      return;
    }
    if (msg?.type === 'client-close' && msg.id != null) {
      const fn = clientCloseByReq.get(msg.id);
      if (fn) {
        clientCloseByReq.delete(msg.id);
        fn();
      } else {
        earlyClose.add(msg.id);
      }
      return;
    }
    if (msg?.type === 'shutdown') {
      try {
        app.dispose();
      } catch {
        /* dispose 幂等 */
      }
      try {
        db.close();
      } catch {
        /* already closed */
      }
      port.postMessage({ type: 'shutdown-ack' });
      return;
    }
  });

  port.postMessage({ type: 'ready' });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  parentPort?.postMessage({ type: 'error', message });
});
