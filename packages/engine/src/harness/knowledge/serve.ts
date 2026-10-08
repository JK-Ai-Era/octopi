/**
 * serve 入口线程模型（v0.63+）
 *
 * - 主线程：listen · /health · token 鉴权 · **纯读直达 Meta/Search Worker** · SSE 泵出
 * - Engine Worker：写路由 + HttpApp + SQLite 写 + ingest（允许阻塞；不影响纯读）
 * - Meta Worker：只读列表/控制面（projects / sources / jobs / ready）
 * - Search Worker：只读检索（search / catalog / files / chunks）
 * - 嵌套 Parse Worker：抽取 / 切块 / FTS token
 *
 * 纯读 **不得** 再 postMessage 进 Engine——ingest 写事务占死写线程时 UI 列表仍须应答。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Worker } from 'node:worker_threads';
import { resolveWorkerUrl } from '../../worker-path.js';
import type { KnowledgeServiceToken } from './http-app.js';
import {
  matchKnowledgeToken,
  type HttpBridgeOutbound,
  type HttpBridgeRequest,
  type HttpBridgeWorkerInbound,
} from './http-bridge.js';
import type { KnowledgeQueryService, QueryWorkerRole } from './query-service.js';
import {
  authenticateRead,
  handleKnowledgeReadHttp,
  isPureReadRoute,
} from './read-http.js';

export interface KnowledgeServeOptions {
  dbPath: string;
  host?: string;
  port?: number;
  tokens: KnowledgeServiceToken[];
  autoRegisterPrincipals?: boolean;
  documentConfig?: import('../capabilities/document/factory.js').DocumentCapabilityConfig | null;
  /** 测试 stub（闭包无法进 Worker）；生产用 embeddingModels */
  testEmbeddingStub?: boolean;
  embed?: {
    enabled?: boolean;
    embedBatch?: number;
    embedMinIntervalMs?: number;
    embedConcurrency?: number;
    embedSecretPolicy?: 'allow' | 'redact' | 'skip';
  } | null;
  sqliteVecExtensionPath?: string;
  embeddingModels?: {
    providers?: Record<string, unknown>;
    embedding?: unknown;
  } | null;
}

export interface KnowledgeServeHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  return Buffer.concat(chunks).toString('utf8');
}

function toBridgeHeaders(
  headers: IncomingMessage['headers'],
): Record<string, string | string[] | undefined> {
  return { ...headers };
}

async function startQueryWorker(opts: {
  dbPath: string;
  role: QueryWorkerRole;
  sqliteVecExtensionPath?: string;
  embeddingModels?: KnowledgeServeOptions['embeddingModels'];
}): Promise<KnowledgeQueryService> {
  const { createKnowledgeQueryService } = await import('./query-service.js');
  return createKnowledgeQueryService({
    dbPath: opts.dbPath,
    mode: 'worker',
    role: opts.role,
    embeddingModels: opts.embeddingModels ?? null,
    ...(opts.sqliteVecExtensionPath
      ? { sqliteVecExtensionPath: opts.sqliteVecExtensionPath }
      : {}),
  });
}

/**
 * 启动 Knowledge HTTP 服务（唯一写者；业务写在 Engine Worker，纯读直达 Query Worker）。
 *
 * @param opts - db 路径 / 监听 / token 表 / embedding
 * @returns 可关闭的 listen handle
 */
export async function startKnowledgeService(
  opts: KnowledgeServeOptions,
): Promise<KnowledgeServeHandle> {
  const useSplitQuery = opts.dbPath !== ':memory:';

  // Engine 先起：建库/建表后 Query Worker 才能只读打开（缺文件时 readOnly 会炸）
  const entry = fileURLToWorker('./engine-thread.js');
  const worker = new Worker(entry, {
    workerData: {
      dbPath: opts.dbPath,
      tokens: opts.tokens,
      autoRegisterPrincipals: opts.autoRegisterPrincipals ?? true,
      documentConfig: opts.documentConfig ?? null,
      sqliteVecExtensionPath: opts.sqliteVecExtensionPath,
      embeddingModels: opts.embeddingModels ?? null,
      embed: opts.embed ?? null,
      testEmbeddingStub: opts.testEmbeddingStub ?? false,
      // 文件库：Engine 不再自建 Query Worker（纯读在主线程）
      skipQueryWorker: useSplitQuery,
    },
    // 嵌套解析 worker 需要相对 dist 加载
    env: process.env,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('knowledge_engine_thread_boot_timeout')), 60_000);
    const onMsg = (msg: { type?: string; message?: string }) => {
      if (msg?.type === 'ready') {
        clearTimeout(timer);
        worker.off('message', onMsg);
        resolve();
      } else if (msg?.type === 'error') {
        clearTimeout(timer);
        worker.off('message', onMsg);
        reject(new Error(msg.message ?? 'knowledge_engine_thread_failed'));
      }
    };
    worker.on('message', onMsg);
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`knowledge_engine_thread_exit_${code}`));
    });
  });

  let metaQuery: KnowledgeQueryService | null = null;
  let searchQuery: KnowledgeQueryService | null = null;
  if (useSplitQuery) {
    try {
      [metaQuery, searchQuery] = await Promise.all([
        startQueryWorker({
          dbPath: opts.dbPath,
          role: 'meta',
          sqliteVecExtensionPath: opts.sqliteVecExtensionPath,
          embeddingModels: opts.embeddingModels,
        }),
        startQueryWorker({
          dbPath: opts.dbPath,
          role: 'search',
          sqliteVecExtensionPath: opts.sqliteVecExtensionPath,
          embeddingModels: opts.embeddingModels,
        }),
      ]);
    } catch (e) {
      await Promise.all([
        metaQuery?.dispose() ?? Promise.resolve(),
        searchQuery?.dispose() ?? Promise.resolve(),
      ]);
      await worker.terminate().catch(() => undefined);
      throw e;
    }
  }

  let nextId = 1;
  /** id → 非 SSE 响应等待 / SSE res */
  const waiters = new Map<
    number,
    {
      resolve: (r: { status: number; headers: Record<string, string | number | string[]>; body: string }) => void;
      reject: (e: Error) => void;
      res?: ServerResponse;
      sse?: boolean;
    }
  >();

  const onBridge = (msg: HttpBridgeOutbound & { id?: number }) => {
    if (msg.id == null) return;
    const w = waiters.get(msg.id);
    if (!w) return;
    if (msg.type === 'end') {
      waiters.delete(msg.id);
      w.resolve({ status: msg.status, headers: msg.headers, body: msg.body });
      return;
    }
    if (msg.type === 'sse-start') {
      if (w.res && !w.res.headersSent) {
        w.res.writeHead(msg.status, msg.headers);
      }
      return;
    }
    if (msg.type === 'sse-write') {
      w.res?.write(msg.chunk);
      return;
    }
    if (msg.type === 'sse-end') {
      waiters.delete(msg.id);
      w.res?.end();
    }
  };
  worker.on('message', onBridge);

  // Engine 崩溃：立即冲刷在途请求，禁止静默挂死到客户端超时
  const failAllWaiters = (reason: string) => {
    for (const [, w] of waiters) {
      if (w.sse && w.res && !w.res.headersSent) {
        try {
          w.res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
          w.res.end(JSON.stringify({ ok: false, error: reason }));
        } catch {
          /* ignore */
        }
      } else if (w.sse) {
        try {
          w.res?.end();
        } catch {
          /* ignore */
        }
      } else {
        w.reject(new Error(reason));
      }
    }
    waiters.clear();
  };
  worker.on('exit', (code, signal) => {
    failAllWaiters(`knowledge_engine_thread_exit_${signal ?? code}`);
  });
  worker.on('error', (err: Error) => {
    failAllWaiters(`knowledge_engine_thread_error:${err.message}`);
  });

  const tokens = opts.tokens;
  const server = createServer((req, res) => {
    void (async () => {
      const id = nextId++;
      try {
        const method = (req.method ?? 'GET').toUpperCase();
        const urlPath = (req.url ?? '/').split('?')[0]?.replace(/\/+$/, '') || '/';

        // 存活探测：Engine 再忙也必须立刻应答（进程级健康，不是业务健康）
        if (method === 'GET' && urlPath === '/health') {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
          });
          res.end(
            JSON.stringify({ ok: true, service: 'knowledge', version: '0.60.0', engine: 'thread' }),
          );
          return;
        }
        if (method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        // Token 鉴权：内存表查找，与 Engine 共用 matchKnowledgeToken
        if (urlPath !== '/health') {
          const hit = matchKnowledgeToken(tokens, req.headers.authorization);
          if (!hit) {
            res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'missing or invalid token' } }),
            );
            return;
          }
        }

        // 纯读：主线程 → Meta/Search Worker（不进 Engine 事件循环）
        if (useSplitQuery && metaQuery && searchQuery && isPureReadRoute(method, urlPath)) {
          const auth = authenticateRead(tokens, req);
          if (!auth) {
            res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'missing or invalid token' } }),
            );
            return;
          }
          const handled = await handleKnowledgeReadHttp(
            {
              meta: metaQuery,
              search: searchQuery,
              tokens,
              autoRegisterPrincipals: opts.autoRegisterPrincipals ?? true,
            },
            req,
            res,
            auth,
          );
          if (handled) return;
        }

        const body = await readBody(req);
        const bridgeReq: HttpBridgeRequest = {
          method,
          url: req.url ?? '/',
          headers: toBridgeHeaders(req.headers),
          body,
        };
        const sse = urlPath === '/v1/events';
        const result = await new Promise<{
          status: number;
          headers: Record<string, string | number | string[]>;
          body: string;
        }>((resolve, reject) => {
          waiters.set(id, {
            resolve,
            reject,
            res: sse ? res : undefined,
            sse,
          });
          const payload: HttpBridgeWorkerInbound = { id, type: 'http', req: bridgeReq };
          worker.postMessage(payload);
          req.on('close', () => {
            if (sse) {
              worker.postMessage({ type: 'client-close', id });
              waiters.delete(id);
              try {
                res.end();
              } catch {
                /* already ended */
              }
            }
          });
        });
        if (!res.headersSent) {
          res.writeHead(result.status, result.headers);
          res.end(result.body);
        }
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        }
      }
    })();
  });

  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 18280;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  const bound = typeof addr === 'object' && addr ? addr.port : port;

  return {
    server,
    port: bound,
    close: async () => {
      for (const [, w] of waiters) {
        w.reject(new Error('knowledge_service_closing'));
      }
      waiters.clear();
      try {
        server.closeAllConnections?.();
      } catch {
        /* old Node */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      await Promise.all([
        metaQuery?.dispose() ?? Promise.resolve(),
        searchQuery?.dispose() ?? Promise.resolve(),
      ]);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          void worker.terminate().finally(() => resolve());
        }, 3_000);
        timer.unref?.();
        const onAck = (msg: { type?: string }) => {
          if (msg?.type === 'shutdown-ack') {
            clearTimeout(timer);
            worker.off('message', onAck);
            resolve();
          }
        };
        worker.on('message', onAck);
        try {
          worker.postMessage({ type: 'shutdown' });
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
      await worker.terminate().catch(() => undefined);
    },
  };
}

function fileURLToWorker(moduleFile: string): URL {
  return resolveWorkerUrl(moduleFile, import.meta.url);
}
