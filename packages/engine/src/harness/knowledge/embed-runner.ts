/**
 * EmbedRunner — Phase B 向量写入（含外发敏感策略）
 *
 * 从 KnowledgeIngest 拆出；不依赖 parse/watch，只吃 index + provider + 控制面回调。
 */

import { randomUUID } from 'node:crypto';
import type { EmbeddingProvider } from '../memory/sqlite/embedding.js';
import type { KnowledgeChunkId } from './types.js';
import type { KnowledgeIndexStore } from './index-store.js';
import { redactSecretShapes, scanSecretShapes } from './secret-scan.js';

/** embedding 外发敏感形态策略 */
export type EmbedSecretPolicy = 'allow' | 'redact' | 'skip';

export interface EmbedRunnerDeps {
  index: KnowledgeIndexStore;
  embedding: EmbeddingProvider | null;
  embedBatch: number;
  embedConcurrency: number;
  embedMinIntervalMs: number;
  embedSecretPolicy: EmbedSecretPolicy;
  isAborted: (sourceId: string) => boolean;
  heartbeatJob: (jobId: string) => void;
  refreshCoverage: (sourceId: string) => void;
  emitProgress: (evt: {
    type: 'embed';
    sourceId: string;
    status: string;
    detail?: string;
  }) => void;
  /** 密钥审计落库（knowledge_embed_secret_log） */
  recordSecretHit: (input: {
    sourceId: string;
    chunkId: string;
    action: string;
    hits: string[];
  }) => void;
}

export class EmbedRunner {
  private lastEmbedAt = 0;

  constructor(private readonly deps: EmbedRunnerDeps) {}

  /**
   * 带硬超时的调用（批/单条）。超时后拒绝并释放槽位。
   * 底层 HTTP 未必可取消——由 provider 负责；本层保证 **不得** 无限占住 embed 槽。
   * （parse 路径用可 abort 的 `withTimeout`；embed 侧以槽位释放为硬约束。）
   */
  private async withDeadline<T>(work: () => Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(label)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Phase B：嵌入待处理 chunk
   *
   * 单 job 内按 embedConcurrency **并行**多批调用 API；
   * 失败/超时也 re-enqueue，避免 job 标 done 后 coverage 永久卡住。
   */
  async embedPending(sourceId: string, maxRounds = 20, jobId?: string): Promise<void> {
    const { index, embedding, isAborted, heartbeatJob, refreshCoverage, emitProgress } = this.deps;
    if (!embedding) {
      if (index.listChunksMissingEmbedding(sourceId, 1).length > 0) {
        throw new Error('embedding_provider_missing');
      }
      return;
    }

    const lanes = Math.max(1, this.deps.embedConcurrency);
    const batchSize = Math.max(1, this.deps.embedBatch);

    for (let round = 0; round < maxRounds; round++) {
      if (isAborted(sourceId)) return;
      const pending = index
        .listChunksMissingEmbedding(sourceId, batchSize * lanes)
        .map((c) => ({ id: c.chunkId as KnowledgeChunkId, text: c.text }));
      if (pending.length === 0) {
        refreshCoverage(sourceId);
        return;
      }
      if (jobId) heartbeatJob(jobId);

      if (this.deps.embedMinIntervalMs > 0) {
        const wait = this.lastEmbedAt + this.deps.embedMinIntervalMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }

      const slices: typeof pending[] = [];
      for (let i = 0; i < pending.length; i += batchSize) {
        slices.push(pending.slice(i, i + batchSize));
      }

      const settled = await Promise.allSettled(
        slices.map((slice) => this.embedOneSlice(sourceId, slice)),
      );

      let ok = 0;
      let failed = false;
      for (const s of settled) {
        if (s.status === 'fulfilled') ok += s.value;
        else failed = true;
      }
      this.lastEmbedAt = Date.now();
      emitProgress({
        type: 'embed',
        sourceId,
        status: 'batch_done',
        detail: `embedded=${ok}/${pending.length} lanes=${slices.length}`,
      });
      if (failed) return;
    }
    refreshCoverage(sourceId);
  }

  private applyEmbedSecretPolicy(
    sourceId: string,
    chunkId: string,
    text: string,
  ): { text: string; skip: boolean } {
    const policy = this.deps.embedSecretPolicy;
    if (policy === 'allow') return { text, skip: false };
    const hits = scanSecretShapes(text);
    if (hits.length === 0) return { text, skip: false };

    const action = policy === 'skip' ? 'skipped' : 'redacted';
    this.deps.recordSecretHit({ sourceId, chunkId, action, hits });
    this.deps.emitProgress({
      type: 'embed',
      sourceId,
      status: 'secret_policy',
      detail: `${action} hits=${hits.join(',')}`,
    });

    if (policy === 'skip') return { text, skip: true };
    return { text: redactSecretShapes(text).text, skip: false };
  }

  private async embedOneSlice(
    sourceId: string,
    slice: Array<{ id: KnowledgeChunkId; text: string }>,
  ): Promise<number> {
    const { index, embedding, isAborted } = this.deps;
    if (slice.length === 0 || !embedding) return 0;

    const prepared: Array<{ id: KnowledgeChunkId; text: string; skip: boolean }> = [];
    for (const p of slice) {
      const r = this.applyEmbedSecretPolicy(sourceId, p.id, p.text);
      prepared.push({ id: p.id, text: r.text, skip: r.skip });
    }
    const outbound = prepared.filter((p) => !p.skip);
    for (const p of prepared) {
      if (p.skip) {
        index.setChunkEmbeddings([[p.id, []]]);
      }
    }
    if (outbound.length === 0) return 0;

    const timeoutMs = 60_000 + 20_000 * outbound.length;
    let vectors: number[][] = [];
    if (!isAborted(sourceId)) {
      try {
        vectors = await this.withDeadline(
          () => embedding.embedBatch(outbound.map((p) => p.text)),
          timeoutMs,
          'embed_batch_timeout',
        );
      } catch {
        vectors = [];
      }
    }

    let ok = 0;
    const batch: Array<[string, number[]]> = [];
    const flush = () => {
      if (batch.length > 0) {
        index.setChunkEmbeddings(batch.splice(0, batch.length));
      }
    };

    for (let i = 0; i < outbound.length; i++) {
      if (isAborted(sourceId)) {
        flush();
        return ok;
      }
      let vec = vectors[i];
      if (!vec?.length) {
        // 单条也必须有硬超时：否则一条挂死永久占住 embed 槽
        try {
          vec = await this.withDeadline(
            () => embedding.embed(outbound[i]!.text),
            30_000,
            'embed_item_timeout',
          );
        } catch {
          vec = [];
        }
      }
      if (vec?.length) {
        batch.push([outbound[i]!.id, vec]);
        ok += 1;
        if (batch.length >= 8) flush();
      }
    }
    flush();
    return ok;
  }
}
