/**
 * Knowledge Service 进程入口 — `octopi knowledge serve` / manageLocal 子进程
 */

import { createServer, type Server } from 'node:http';
import { KnowledgeDatabase } from './db.js';
import { createKnowledgeHttpApp, type KnowledgeServiceToken } from './http-app.js';

export interface KnowledgeServeOptions {
  dbPath: string;
  host?: string;
  port?: number;
  tokens: KnowledgeServiceToken[];
  autoRegisterPrincipals?: boolean;
  /** documents.* — 与 Gateway 同源的抽取/legacy 配置 */
  documentConfig?: import('../capabilities/document/factory.js').DocumentCapabilityConfig | null;
}

export interface KnowledgeServeHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/**
 * 启动 Knowledge HTTP 服务（唯一写者）。
 *
 * @param opts - db 路径 / 监听 / token 表
 * @returns 可关闭的 listen handle
 */
export async function startKnowledgeService(
  opts: KnowledgeServeOptions,
): Promise<KnowledgeServeHandle> {
  const db = await KnowledgeDatabase.create({ dbPath: opts.dbPath });
  const app = createKnowledgeHttpApp({
    db,
    tokens: opts.tokens,
    autoRegisterPrincipals: opts.autoRegisterPrincipals ?? false,
    documentConfig: opts.documentConfig ?? null,
  });
  const server = createServer((req, res) => {
    void app.handle(req, res);
  });
  const host = opts.host ?? '127.0.0.1';
  // 缺省 18280（契约）；0 = 临时端口（仅测试）
  const port = opts.port ?? 18280;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // 注册后自动 ingest + 恢复 watch/reconciler/poll（否则源停在 pending 永不解析）
  app.startIngestRuntime();
  const addr = server.address();
  const bound = typeof addr === 'object' && addr ? addr.port : port;
  return {
    server,
    port: bound,
    close: async () => {
      // dispose 先于 drain：SSE 会让 server.close 永不回调
      try {
        app.dispose();
      } catch {
        /* dispose 幂等失败不影响收尾 */
      }
      try {
        server.closeAllConnections?.();
      } catch {
        /* 旧 Node 无此 API */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      try {
        db.close();
      } catch {
        /* db 已关 */
      }
    },
  };
}
