/**
 * WorkerWriteService — API 线程侧 Writer RPC 客户端
 *
 * 不持有 SQLite；一切变更进 Writer Worker（唯一写者）。
 */
import { Worker } from 'node:worker_threads';
import { resolveWorkerUrl } from '../../worker-path.js';
import type {
  KnowledgeWriteService,
  WriteIdentity,
  WriteAbortStats,
  WriteResumeStats,
  WriteRegisterResult,
  WriteDescribeResult,
  WriteReprocessResult,
} from './writer-service.js';
import type { KnowledgeSource } from './types.js';
import type { KnowledgeJobControlState } from './job-control-state.js';
import type { IngestProgressEvent } from './ingest.js';
import type { DocumentCapabilityConfig } from '../capabilities/document/factory.js';

interface WriterReply {
  id?: number;
  ok?: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  type?: string;
  evt?: IngestProgressEvent;
  message?: string;
}

export interface WorkerWriteStartOptions {
  dbPath: string;
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
  timeoutMs?: number;
}

export class WorkerWriteService implements KnowledgeWriteService {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly progressCbs = new Set<(evt: IngestProgressEvent) => void>();
  private disposed = false;
  private bootSettled = false;
  private bootResolve: (() => void) | null = null;
  private bootReject: ((e: Error) => void) | null = null;
  private readonly bootPromise: Promise<void>;
  private readonly timeoutMs: number;

  private constructor(private readonly worker: Worker, timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    this.bootPromise = new Promise<void>((resolve, reject) => {
      this.bootResolve = resolve;
      this.bootReject = reject;
    });
    worker.on('message', (msg: WriterReply) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        if (!this.bootSettled) {
          this.bootSettled = true;
          this.bootResolve?.();
        }
        return;
      }
      if (msg.type === 'error') {
        const e = new Error(msg.message ?? 'knowledge_writer_boot_failed');
        if (!this.bootSettled) {
          this.bootSettled = true;
          this.bootReject?.(e);
        }
        return;
      }
      if (msg.type === 'progress' && msg.evt) {
        for (const cb of this.progressCbs) {
          try {
            cb(msg.evt);
          } catch {
            /* SSE 订阅方异常不得打断 */
          }
        }
        return;
      }
      if (msg.id == null) return;
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      clearTimeout(slot.timer);
      if (msg.ok) slot.resolve(msg.data);
      else {
        const err = new Error(msg.error ?? 'knowledge_write_failed');
        if (msg.code) (err as { code?: string }).code = msg.code;
        slot.reject(err);
      }
    });
    worker.on('error', (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      if (!this.bootSettled) {
        this.bootSettled = true;
        this.bootReject?.(e);
      }
      this.failAll(e);
    });
    worker.on('exit', () => {
      const e = new Error('knowledge_writer_worker_exit');
      if (!this.bootSettled) {
        this.bootSettled = true;
        this.bootReject?.(e);
      }
      this.failAll(e);
    });
  }

  static async start(opts: WorkerWriteStartOptions): Promise<WorkerWriteService> {
    const worker = new Worker(resolveWorkerUrl('./writer-worker.js', import.meta.url), {
      workerData: {
        dbPath: opts.dbPath,
        documentConfig: opts.documentConfig ?? null,
        sqliteVecExtensionPath: opts.sqliteVecExtensionPath,
        embeddingModels: opts.embeddingModels ?? null,
        embed: opts.embed ?? null,
        testEmbeddingStub: opts.testEmbeddingStub ?? false,
      },
      env: process.env,
    });
    const client = new WorkerWriteService(worker, opts.timeoutMs ?? 60_000);
    const bootTimer = setTimeout(() => {
      if (!client.bootSettled) {
        client.bootSettled = true;
        client.bootReject?.(new Error('knowledge_writer_boot_timeout'));
      }
    }, 60_000);
    try {
      await client.bootPromise;
    } finally {
      clearTimeout(bootTimer);
    }
    return client;
  }

  private failAll(err: Error): void {
    for (const [, slot] of this.pending) {
      clearTimeout(slot.timer);
      slot.reject(err);
    }
    this.pending.clear();
  }

  private call(method: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error('knowledge_write_disposed'));
    }
    const id = this.nextId++;
    const ms = timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`knowledge_write_timeout after ${ms}ms`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, method, args });
    });
  }

  private static err(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
  }

  private rethrow(err: unknown): never {
    if (err instanceof Error && (err as { code?: string }).code) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/not resource owner|not source owner|not project owner/i.test(msg)) {
      throw WorkerWriteService.err('not_resource_owner', msg);
    }
    if (/principal not registered/i.test(msg)) {
      throw WorkerWriteService.err('principal_not_registered', msg);
    }
    if (/not principal owner/i.test(msg)) {
      throw WorkerWriteService.err('not_principal_owner', msg);
    }
    if (/source not found/i.test(msg)) {
      throw WorkerWriteService.err('source_not_found', msg);
    }
    if (/not empty|non-empty|仍有/i.test(msg)) {
      throw WorkerWriteService.err('project_not_empty', msg);
    }
    if (/items\[\] invalid/i.test(msg)) {
      throw WorkerWriteService.err('bad_request', msg);
    }
    throw err instanceof Error ? err : new Error(msg);
  }

  async upsertPrincipal(
    identity: WriteIdentity,
    agentId: string,
    body: { displayName?: string; status?: string },
  ): Promise<void> {
    try {
      await this.call('upsertPrincipal', { identity, agentId, body });
    } catch (e) {
      this.rethrow(e);
    }
  }

  async ensurePrincipal(
    identity: WriteIdentity,
    agentId: string,
    autoRegister: boolean,
  ): Promise<void> {
    try {
      await this.call('ensurePrincipal', { identity, agentId, autoRegister });
    } catch (e) {
      this.rethrow(e);
    }
  }

  async assertOwnPrincipal(identity: WriteIdentity, agentId: string): Promise<void> {
    try {
      await this.call('assertOwnPrincipal', { identity, agentId });
    } catch (e) {
      this.rethrow(e);
    }
  }

  async createProject(
    identity: WriteIdentity,
    input: { projectKey: string; displayName?: string; visibility?: string },
  ): Promise<{
    projectKey: string;
    displayName: string | null;
    registeredBy: string;
    visibility: 'public' | 'private';
  }> {
    try {
      return (await this.call('createProject', { identity, input })) as never;
    } catch (e) {
      this.rethrow(e);
    }
  }

  async removeProject(
    identity: WriteIdentity,
    projectKey: string,
  ): Promise<{ projectKey: string; removed: boolean }> {
    try {
      return (await this.call('removeProject', { identity, projectKey })) as never;
    } catch (e) {
      this.rethrow(e);
    }
  }

  async registerSource(
    identity: WriteIdentity,
    input: Record<string, unknown>,
  ): Promise<WriteRegisterResult> {
    try {
      return (await this.call('registerSource', { identity, input }, 120_000)) as never;
    } catch (e) {
      this.rethrow(e);
    }
  }

  async updateSource(
    identity: WriteIdentity,
    sourceId: string,
    patch: Record<string, unknown>,
  ): Promise<KnowledgeSource | null> {
    try {
      return (await this.call('updateSource', { identity, sourceId, patch })) as never;
    } catch (e) {
      this.rethrow(e);
    }
  }

  async removeSource(
    identity: WriteIdentity,
    sourceId: string,
  ): Promise<{ id: string; purgedFiles: number }> {
    try {
      return (await this.call('removeSource', { identity, sourceId }, 120_000)) as never;
    } catch (e) {
      this.rethrow(e);
    }
  }

  async describeSource(
    identity: WriteIdentity,
    sourceId: string,
  ): Promise<WriteDescribeResult | null> {
    try {
      return (await this.call('describeSource', { identity, sourceId })) as never;
    } catch (e) {
      this.rethrow(e);
    }
  }

  async reindexSource(sourceId: string): Promise<void> {
    try {
      await this.call('reindexSource', { sourceId });
    } catch (e) {
      this.rethrow(e);
    }
  }

  async reprocessFiles(sourceId: string, paths: string[]): Promise<WriteReprocessResult> {
    try {
      return (await this.call('reprocessFiles', { sourceId, paths }, 120_000)) as never;
    } catch (e) {
      this.rethrow(e);
    }
  }

  async reprocessByFilter(
    sourceId: string,
    filter?: { status?: string; ext?: string; q?: string },
  ): Promise<WriteReprocessResult> {
    try {
      return (await this.call('reprocessByFilter', { sourceId, filter }, 120_000)) as never;
    } catch (e) {
      this.rethrow(e);
    }
  }

  async abortSource(sourceId: string): Promise<WriteAbortStats & KnowledgeJobControlState> {
    try {
      return (await this.call('abortSource', { sourceId }, 15_000)) as never;
    } catch (e) {
      this.rethrow(e);
    }
  }

  async resumeSource(sourceId: string): Promise<KnowledgeJobControlState> {
    try {
      return (await this.call('resumeSource', { sourceId }, 15_000)) as never;
    } catch (e) {
      this.rethrow(e);
    }
  }

  async abortAllOwned(identity: WriteIdentity): Promise<WriteAbortStats> {
    try {
      return (await this.call('abortAllOwned', { identity }, 30_000)) as never;
    } catch (e) {
      this.rethrow(e);
    }
  }

  async resumeAllOwned(identity: WriteIdentity): Promise<WriteResumeStats> {
    try {
      return (await this.call('resumeAllOwned', { identity }, 30_000)) as never;
    } catch (e) {
      this.rethrow(e);
    }
  }

  async assignProject(
    identity: WriteIdentity,
    agentId: string,
    projectKey: string,
  ): Promise<void> {
    try {
      await this.call('assignProject', { identity, agentId, projectKey });
    } catch (e) {
      this.rethrow(e);
    }
  }

  async unassignProject(
    identity: WriteIdentity,
    agentId: string,
    projectKey: string,
  ): Promise<void> {
    try {
      await this.call('unassignProject', { identity, agentId, projectKey });
    } catch (e) {
      this.rethrow(e);
    }
  }

  async hideSource(identity: WriteIdentity, agentId: string, sourceId: string): Promise<void> {
    try {
      await this.call('hideSource', { identity, agentId, sourceId });
    } catch (e) {
      this.rethrow(e);
    }
  }

  async unhideSource(identity: WriteIdentity, agentId: string, sourceId: string): Promise<void> {
    try {
      await this.call('unhideSource', { identity, agentId, sourceId });
    } catch (e) {
      this.rethrow(e);
    }
  }

  async replaceSessionVisibility(
    identity: WriteIdentity,
    agentId: string,
    sessionId: string,
    items: Array<{ targetType: string; targetId: string; op: string }>,
  ): Promise<number> {
    try {
      return (await this.call('replaceSessionVisibility', {
        identity,
        agentId,
        sessionId,
        items,
      })) as number;
    } catch (e) {
      this.rethrow(e);
    }
  }

  async setSessionVisibilityItem(
    identity: WriteIdentity,
    sessionId: string,
    item: { targetType: 'project' | 'source'; targetId: string; op: 'include' | 'exclude' },
  ): Promise<void> {
    try {
      await this.call('setSessionVisibilityItem', { identity, sessionId, item });
    } catch (e) {
      this.rethrow(e);
    }
  }

  async clearSessionVisibility(
    identity: WriteIdentity,
    sessionId: string,
    target?: { targetType: 'project' | 'source'; targetId: string },
  ): Promise<void> {
    try {
      await this.call('clearSessionVisibility', { identity, sessionId, target });
    } catch (e) {
      this.rethrow(e);
    }
  }

  async isSourceOwner(sourceId: string, gatewayId: string): Promise<boolean> {
    return (await this.call('isSourceOwner', { sourceId, gatewayId }, 10_000)) as boolean;
  }

  async sourceVisibleToGateway(sourceId: string, gatewayId: string): Promise<boolean> {
    return (await this.call('sourceVisibleToGateway', { sourceId, gatewayId }, 10_000)) as boolean;
  }

  async startIngestRuntime(): Promise<void> {
    await this.call('startIngestRuntime', {}, 30_000);
  }

  onProgress(cb: (evt: IngestProgressEvent) => void): () => void {
    this.progressCbs.add(cb);
    return () => {
      this.progressCbs.delete(cb);
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.call('shutdown', {}, 10_000);
    } catch {
      /* worker 可能已退 */
    }
    this.disposed = true;
    this.failAll(new Error('knowledge_write_disposed'));
    await this.worker.terminate();
  }
}
