/**
 * Writer Worker — knowledge.db 唯一写者 + ingest
 *
 * API 线程（engine-thread）只做写路由编排；本线程独占写连接与 KnowledgeIngest。
 * 长同步段必须让出（见 index-store / ingest），否则控制 RPC（abort）会排队。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { KnowledgeDatabase } from './db.js';
import {
  LocalKnowledgeWriteService,
  type WriteIdentity,
} from './writer-service.js';
import type { DocumentCapabilityConfig } from '../capabilities/document/factory.js';
import type { IngestProgressEvent } from './ingest.js';

interface WriterBoot {
  dbPath: string;
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
  testEmbeddingStub?: boolean;
}

type WriterCall = {
  id: number;
  method: string;
  args?: Record<string, unknown>;
};

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
  const boot = workerData as WriterBoot;
  const port = parentPort;
  if (!port) throw new Error('knowledge writer worker requires parentPort');

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

  const write = new LocalKnowledgeWriteService({
    db,
    documentConfig: boot.documentConfig ?? null,
    embeddingProvider: embeddingProvider as never,
    embed: boot.embed ?? null,
  });

  write.onProgress((evt: IngestProgressEvent) => {
    port.postMessage({ type: 'progress', evt });
  });

  port.on('message', (msg: WriterCall) => {
    void (async () => {
      const id = msg?.id;
      if (id == null) return;
      try {
        if (msg.method === 'shutdown') {
          try {
            await write.dispose();
          } catch {
            /* dispose 幂等 */
          }
          try {
            db.close();
          } catch {
            /* already closed */
          }
          port.postMessage({ id, ok: true, data: null });
          port.close();
          return;
        }
        const args = msg.args ?? {};
        const identity = args.identity as WriteIdentity | undefined;
        let data: unknown;
        switch (msg.method) {
          case 'upsertPrincipal':
            await write.upsertPrincipal(
              identity!,
              String(args.agentId),
              (args.body as { displayName?: string; status?: string }) ?? {},
            );
            data = null;
            break;
          case 'ensurePrincipal':
            await write.ensurePrincipal(
              identity!,
              String(args.agentId),
              Boolean(args.autoRegister),
            );
            data = null;
            break;
          case 'assertOwnPrincipal':
            await write.assertOwnPrincipal(identity!, String(args.agentId));
            data = null;
            break;
          case 'createProject':
            data = await write.createProject(
              identity!,
              args.input as { projectKey: string; displayName?: string; visibility?: string },
            );
            break;
          case 'removeProject':
            data = await write.removeProject(identity!, String(args.projectKey));
            break;
          case 'registerSource':
            data = await write.registerSource(
              identity!,
              args.input as Record<string, unknown>,
            );
            break;
          case 'updateSource':
            data = await write.updateSource(
              identity!,
              String(args.sourceId),
              (args.patch as Record<string, unknown>) ?? {},
            );
            break;
          case 'removeSource':
            data = await write.removeSource(identity!, String(args.sourceId));
            break;
          case 'describeSource':
            data = await write.describeSource(identity!, String(args.sourceId));
            break;
          case 'reindexSource':
            await write.reindexSource(String(args.sourceId));
            data = null;
            break;
          case 'reprocessFiles':
            data = await write.reprocessFiles(
              String(args.sourceId),
              (args.paths as string[]) ?? [],
            );
            break;
          case 'reprocessByFilter':
            data = await write.reprocessByFilter(
              String(args.sourceId),
              args.filter as
                | { status?: 'indexed' | 'skipped' | 'error' | 'all'; ext?: string; q?: string }
                | undefined,
            );
            break;
          case 'abortSource':
            data = await write.abortSource(String(args.sourceId));
            break;
          case 'resumeSource':
            data = await write.resumeSource(String(args.sourceId));
            break;
          case 'abortAllOwned':
            data = await write.abortAllOwned(identity!);
            break;
          case 'resumeAllOwned':
            data = await write.resumeAllOwned(identity!);
            break;
          case 'assignProject':
            await write.assignProject(identity!, String(args.agentId), String(args.projectKey));
            data = null;
            break;
          case 'unassignProject':
            await write.unassignProject(identity!, String(args.agentId), String(args.projectKey));
            data = null;
            break;
          case 'hideSource':
            await write.hideSource(identity!, String(args.agentId), String(args.sourceId));
            data = null;
            break;
          case 'unhideSource':
            await write.unhideSource(identity!, String(args.agentId), String(args.sourceId));
            data = null;
            break;
          case 'replaceSessionVisibility':
            data = await write.replaceSessionVisibility(
              identity!,
              String(args.agentId),
              String(args.sessionId),
              (args.items as Array<{ targetType: string; targetId: string; op: string }>) ?? [],
            );
            break;
          case 'setSessionVisibilityItem':
            await write.setSessionVisibilityItem(
              identity!,
              String(args.sessionId),
              args.item as {
                targetType: 'project' | 'source';
                targetId: string;
                op: 'include' | 'exclude';
              },
            );
            data = null;
            break;
          case 'clearSessionVisibility':
            await write.clearSessionVisibility(
              identity!,
              String(args.sessionId),
              args.target as
                | { targetType: 'project' | 'source'; targetId: string }
                | undefined,
            );
            data = null;
            break;
          case 'isSourceOwner':
            data = await write.isSourceOwner(String(args.sourceId), String(args.gatewayId));
            break;
          case 'sourceVisibleToGateway':
            data = await write.sourceVisibleToGateway(
              String(args.sourceId),
              String(args.gatewayId),
            );
            break;
          case 'startIngestRuntime':
            await write.startIngestRuntime();
            data = null;
            break;
          default:
            throw new Error(`unknown_write_method:${msg.method}`);
        }
        port.postMessage({ id, ok: true, data });
      } catch (err) {
        port.postMessage({
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: (err as { code?: string }).code,
        });
      }
    })();
  });

  port.postMessage({ type: 'ready' });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  parentPort?.postMessage({ type: 'error', message });
});
