/**
 * Memory Extraction — JSONL Extractor Store
 *
 * 将提取素材落盘为 JSONL 文件，支持 append events 与 save/load bundle。
 * 目录结构（按 agent 隔离）：
 *   <agentHome>/
 *     extract/
 *       events/<sessionId>.jsonl      ← 每行一个 SessionExtractEvent
 *       bundles/<sessionId>.json      ← 最近一次 SessionExtractBundle
 *       meta/<sessionId>.json         ← 元数据（lifecycle/extractionStatus 等）
 *
 * 设计要点：
 * - appendEvents 使用 appendFile，避免覆盖历史事件
 * - saveBundle 使用 writeFile 覆盖（保存最新快照）
 * - 所有方法都要求 agentId，不做全量扫描
 *
 * @module harness/memory/extraction/jsonl-extractor-store
 */

import { access, mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionExtractBundle, SessionExtractEvent } from './session-extractor.js';
import type { ExtractorMeta, ExtractorStore } from './extractor-store.js';

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export class JsonlExtractorStore implements ExtractorStore {
  private agentHomeResolver: (agentId: string) => string;

  constructor(agentHomeResolver: (agentId: string) => string) {
    this.agentHomeResolver = agentHomeResolver;
  }

  private base(agentId: string): string {
    return join(this.agentHomeResolver(agentId), 'extract');
  }

  private eventsFile(agentId: string, sessionId: string): string {
    return join(this.base(agentId), 'events', `${sessionId}.jsonl`);
  }

  private bundleFile(agentId: string, sessionId: string): string {
    return join(this.base(agentId), 'bundles', `${sessionId}.json`);
  }

  private metaFile(agentId: string, sessionId: string): string {
    return join(this.base(agentId), 'meta', `${sessionId}.json`);
  }

  private metaDir(agentId: string): string {
    return join(this.base(agentId), 'meta');
  }

  async appendEvents(agentId: string, sessionId: string, events: SessionExtractEvent[]): Promise<void> {
    const file = this.eventsFile(agentId, sessionId);
    await mkdir(join(this.base(agentId), 'events'), { recursive: true });

    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await appendFile(file, lines, 'utf-8');

    // 更新 meta
    const prev = await this.loadMeta(agentId, sessionId);
    await this.writeMeta(agentId, sessionId, {
      ...(prev ?? { sessionId, agentId }),
      eventCount: (prev?.eventCount ?? 0) + events.length,
      updatedAt: Date.now(),
    });
  }

  async loadEvents(agentId: string, sessionId: string): Promise<SessionExtractEvent[]> {
    const file = this.eventsFile(agentId, sessionId);
    if (!await exists(file)) return [];

    const content = await readFile(file, 'utf-8');
    return content
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l) as SessionExtractEvent; } catch { return null; }
      })
      .filter(Boolean) as SessionExtractEvent[];
  }

  async saveBundle(agentId: string, sessionId: string, bundle: SessionExtractBundle, meta?: ExtractorMeta): Promise<void> {
    const file = this.bundleFile(agentId, sessionId);
    await mkdir(join(this.base(agentId), 'bundles'), { recursive: true });
    await writeFile(file, JSON.stringify(bundle, null, 2), 'utf-8');

    const prev = await this.loadMeta(agentId, sessionId);
    await this.writeMeta(agentId, sessionId, {
      ...(prev ?? { sessionId, agentId }),
      ...meta,
      updatedAt: Date.now(),
    });
  }

  async loadBundle(agentId: string, sessionId: string): Promise<SessionExtractBundle | null> {
    const file = this.bundleFile(agentId, sessionId);
    if (!await exists(file)) return null;

    const content = await readFile(file, 'utf-8');
    try {
      return JSON.parse(content) as SessionExtractBundle;
    } catch {
      return null;
    }
  }

  async updateMeta(agentId: string, sessionId: string, meta: ExtractorMeta): Promise<void> {
    const prev = await this.loadMeta(agentId, sessionId);
    await this.writeMeta(agentId, sessionId, {
      ...(prev ?? { sessionId, agentId }),
      ...meta,
      updatedAt: Date.now(),
    });
  }

  async listPending(agentId: string): Promise<ExtractorMeta[]> {
    const dir = this.metaDir(agentId);
    if (!await exists(dir)) return [];

    const files = await readdir(dir);
    const result: ExtractorMeta[] = [];

    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const sessionId = f.replace(/\.json$/, '');
      const m = await this.loadMeta(agentId, sessionId);
      if (!m) continue;
      if ((m.extractionStatus ?? 'pending') === 'pending') {
        result.push(m);
      }
    }

    return result;
  }

  private async loadMeta(agentId: string, sessionId: string): Promise<ExtractorMeta | null> {
    const file = this.metaFile(agentId, sessionId);
    if (!await exists(file)) return null;
    try {
      return JSON.parse(await readFile(file, 'utf-8')) as ExtractorMeta;
    } catch {
      return null;
    }
  }

  private async writeMeta(agentId: string, sessionId: string, meta: ExtractorMeta): Promise<void> {
    const file = this.metaFile(agentId, sessionId);
    await mkdir(join(this.base(agentId), 'meta'), { recursive: true });
    await writeFile(file, JSON.stringify(meta, null, 2), 'utf-8');
  }
}
