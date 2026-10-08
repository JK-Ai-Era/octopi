/**
 * 测试 / :memory: 用：同进程 Write + Query 装配（非生产路径）。
 */
import { KnowledgeDatabase } from './db.js';
import { KnowledgeSourceStore } from './source-store.js';
import { KnowledgeIndexStore } from './index-store.js';
import { KnowledgeRetriever } from './retriever.js';
import { LocalKnowledgeQueryService } from './query-service.js';
import { LocalKnowledgeWriteService } from './writer-service.js';
import {
  KnowledgeHttpApp,
  createKnowledgeHttpApp,
  type KnowledgeServiceToken,
} from './http-app.js';

export interface LocalKnowledgeStack {
  db: KnowledgeDatabase;
  write: LocalKnowledgeWriteService;
  query: LocalKnowledgeQueryService;
  app: KnowledgeHttpApp;
  dispose(): Promise<void>;
}

/**
 * 同进程装配 HttpApp（单元测试）。生产走 engine-thread + Writer Worker。
 *
 * @param opts - db 路径 / token / autoRegister
 * @returns 可关闭的 stack
 */
export async function createLocalKnowledgeStack(opts: {
  dbPath?: string;
  tokens: KnowledgeServiceToken[];
  autoRegisterPrincipals?: boolean;
  embeddingProvider?: import('../memory/sqlite/embedding.js').EmbeddingProvider | null;
  testEmbeddingStub?: boolean;
}): Promise<LocalKnowledgeStack> {
  const db = await KnowledgeDatabase.create({ dbPath: opts.dbPath ?? ':memory:' });
  const embeddingProvider =
    opts.testEmbeddingStub === true
      ? {
          name: 'test-stub',
          dimensions: 4,
          async embed() {
            return [0.1, 0.2, 0.3, 0.4];
          },
          async embedBatch(texts: string[]) {
            return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
          },
        }
      : (opts.embeddingProvider ?? null);
  const write = new LocalKnowledgeWriteService({
    db,
    embeddingProvider: embeddingProvider as never,
  });
  const sources = write.sources;
  const index = write.index;
  const retriever = new KnowledgeRetriever({
    sourceStore: sources,
    indexStore: index,
    embeddingProvider: embeddingProvider as never,
  });
  const query = new LocalKnowledgeQueryService({
    db,
    sources,
    index,
    retriever,
    embeddingEnabled: Boolean(embeddingProvider),
  });
  const app = createKnowledgeHttpApp({
    write,
    query,
    tokens: opts.tokens,
    autoRegisterPrincipals: opts.autoRegisterPrincipals ?? true,
  });
  return {
    db,
    write,
    query,
    app,
    dispose: async () => {
      await app.dispose();
      db.close();
    },
  };
}
