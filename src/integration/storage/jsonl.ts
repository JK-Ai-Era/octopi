/**
 * JsonlSessionStore — JSONL 文件存储（Session 一等）
 *
 * 唯一权威目录（与 agent home 解耦，无 legacy 回退）：
 *   <sessionsDir>/
 *     sessions.json          ← 所有 session 的元数据索引（键 = sessionId；含 lifecycle 投影）
 *     <sessionId>.jsonl      ← 对话记录（JSONL；save 整聚合快照写回，非磁盘 append-only）
 *     <sessionId>.state.json ← 附带状态（tasks / turns / metadata / 模型 2 字段）
 *
 * 主键 = sessionId；文件名一律 `toSessionFileName`（跨平台安全）。
 * 可选 `index`：可重建检索投影（失败不阻断权威写）。禁止把 index 当权威。
 * `sessions.json` parse 失败会拒绝写回，避免清空 meta。
 */

import { access, mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionStore, SessionListFilter } from '../../core/interfaces/session-store.js';
import type { SessionData } from '../../harness/session-types.js';
import type { SessionMeta } from '../../core/types.js';
import { toSessionFileName } from './session-filename.js';
import { sessionMatchesAgent } from './memory.js';
import type { SessionIndexSink } from './session-index.js';

export interface JsonlSessionStoreOptions {
  /** Session 权威目录（通常 `OCTOPI_HOME/sessions`） */
  sessionsDir: string;
  /**
   * 可选投影索引（I2：可重建）。save/delete 旁路 upsert；索引失败不阻断权威写。
   */
  index?: SessionIndexSink;
}

/** sessions.json 索引条目 */
type SessionIndex = Record<string, SessionMeta>;

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export class JsonlSessionStore implements SessionStore<SessionData> {
  private readonly sessionsDir: string;
  private readonly index?: SessionIndexSink;

  /**
   * @param options - sessionsDir + 可选 index
   */
  constructor(options: JsonlSessionStoreOptions) {
    this.sessionsDir = options.sessionsDir;
    this.index = options.index;
  }

  private metaFile(): string {
    return join(this.sessionsDir, 'sessions.json');
  }

  private sessionFile(sessionId: string): string {
    return join(this.sessionsDir, `${toSessionFileName(sessionId)}.jsonl`);
  }

  private sessionStateFile(sessionId: string): string {
    return join(this.sessionsDir, `${toSessionFileName(sessionId)}.state.json`);
  }

  private async readMetaIndex(): Promise<SessionIndex> {
    const metaPath = this.metaFile();
    if (!(await fileExists(metaPath))) return {};
    const raw = await readFile(metaPath, 'utf-8');
    try {
      return JSON.parse(raw) as SessionIndex;
    } catch {
      // parse 失败禁止当 {} 写回（会清空全部 meta）；抛错拒绝本次 save/delete
      throw new Error(`corrupt sessions.json meta index at ${metaPath}; refusing to overwrite`);
    }
  }

  private async writeMetaIndex(index: SessionIndex): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    const tmpPath = `${this.metaFile()}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(index, null, 2));
    await rename(tmpPath, this.metaFile());
  }

  private buildIndexEntry(data: SessionData): SessionMeta {
    const participantAgentIds =
      data.meta.participantAgentIds ??
      (data.participants ?? []).map((p) => p.agentId);
    const lifecycle = data.lifecycle?.lifecycle ?? data.meta.lifecycle ?? 'active';
    return {
      ...data.meta,
      id: data.id,
      agentId: data.agentId || data.meta.agentId,
      primaryAgentId: data.primaryAgentId ?? data.meta.primaryAgentId,
      preferredAgentId: data.preferredAgentId ?? data.meta.preferredAgentId,
      participantAgentIds,
      lifecycle,
      endedAt: data.lifecycle?.endedAt ?? data.meta.endedAt,
      archivedAt: data.lifecycle?.archivedAt ?? data.meta.archivedAt,
    };
  }

  private async readSession(
    sessionId: string,
    resolved: { messages: string | null; state: string | null },
  ): Promise<SessionData | null> {
    let messages: SessionData['messages'] = [];
    if (resolved.messages) {
      const content = await readFile(resolved.messages, 'utf-8');
      messages = content.split('\n')
        .filter(line => line.trim())
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    }

    const meta = (await this.readMetaIndex())[sessionId] ?? null;

    let state: {
      agentId?: string;
      primaryAgentId?: string;
      preferredAgentId?: string;
      switchAudit?: SessionData['switchAudit'];
      participants?: SessionData['participants'];
      contextCompact?: SessionData['contextCompact'];
      contextCompacts?: SessionData['contextCompacts'];
      lifecycle?: SessionData['lifecycle'];
      tasks?: SessionData['tasks'];
      turns?: SessionData['turns'];
      metadata?: SessionData['metadata'];
    } = {};
    if (resolved.state) {
      try {
        state = JSON.parse(await readFile(resolved.state, 'utf-8'));
      } catch { /* corrupt state, ignore */ }
    }

    const agentId = state.agentId ?? meta?.agentId ?? 'default';
    const lifecycle = state.lifecycle ?? (meta?.lifecycle
      ? {
          lifecycle: meta.lifecycle,
          memoryExtraction: undefined,
          endedAt: meta.endedAt,
          archivedAt: meta.archivedAt,
        }
      : undefined);
    return {
      id: sessionId,
      agentId,
      primaryAgentId: state.primaryAgentId ?? meta?.primaryAgentId ?? agentId,
      preferredAgentId: state.preferredAgentId ?? meta?.preferredAgentId,
      switchAudit: state.switchAudit,
      participants: state.participants,
      contextCompact: state.contextCompact,
      contextCompacts: state.contextCompacts,
      lifecycle,
      meta: meta ?? {
        id: sessionId,
        agentId,
        channelId: 'unknown',
        peerId: 'unknown',
        status: 'idle',
        createdAt: Date.now(),
        sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(),
        updatedAt: Date.now(),
      },
      messages,
      turns: state.turns ?? [],
      metadata: state.metadata ?? {},
      tasks: state.tasks ?? [],
    };
  }

  private async removeSessionFiles(sessionId: string): Promise<void> {
    for (const p of [this.sessionFile(sessionId), this.sessionStateFile(sessionId)]) {
      if (await fileExists(p)) {
        await unlink(p);
      }
    }
    const metaPath = this.metaFile();
    if (await fileExists(metaPath)) {
      try {
        const allMeta = await this.readMetaIndex();
        delete allMeta[sessionId];
        await writeFile(metaPath, JSON.stringify(allMeta, null, 2));
      } catch { /* ignore */ }
    }
  }

  async load(sessionId: string): Promise<SessionData | null> {
    const messagesPath = this.sessionFile(sessionId);
    const statePath = this.sessionStateFile(sessionId);
    const hasMessages = await fileExists(messagesPath);
    const hasState = await fileExists(statePath);
    if (!hasMessages && !hasState) return null;
    return this.readSession(sessionId, {
      messages: hasMessages ? messagesPath : null,
      state: hasState ? statePath : null,
    });
  }

  async save(sessionId: string, data: SessionData): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });

    // 写数据文件在前，索引在后：crash 时索引最多缺条目（load 仍能直接读文件），
    // 不会出现索引有但数据没写完的不一致
    const jsonl = data.messages.map(msg => JSON.stringify(msg)).join('\n') + '\n';
    await writeFile(this.sessionFile(sessionId), jsonl);

    await writeFile(this.sessionStateFile(sessionId), JSON.stringify({
      agentId: data.agentId,
      primaryAgentId: data.primaryAgentId ?? data.agentId,
      preferredAgentId: data.preferredAgentId,
      switchAudit: data.switchAudit ?? [],
      participants: data.participants ?? [],
      contextCompact: data.contextCompact,
      contextCompacts: data.contextCompacts,
      lifecycle: data.lifecycle,
      tasks: data.tasks ?? [],
      turns: data.turns ?? [],
      metadata: data.metadata ?? {},
    }, null, 2));

    // 索引携带 lifecycle 投影：list 过滤 / 归档扫描不必打开 state

    // 索引最后更新：数据就绪才写入
    const index = await this.readMetaIndex();
    index[sessionId] = this.buildIndexEntry({ ...data, id: sessionId });
    await this.writeMetaIndex(index);

    // 可搜投影（失败不阻断；权威已落盘，可 rebuild）
    if (this.index) {
      try {
        await this.index.upsertFromSession(sessionId, { ...data, id: sessionId });
      } catch (err) {
        // 投影可重建，吞掉索引写失败（不拖垮权威 save）
        console.warn(
          `[JsonlSessionStore] session index upsert failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async list(filter?: SessionListFilter): Promise<SessionMeta[]> {
    let entries = Object.values(await this.readMetaIndex());
    if (filter?.agentId) {
      const agentId = filter.agentId;
      entries = entries.filter((e) => sessionMatchesAgent(e, agentId));
    }
    return entries;
  }

  /**
   * 按会话事实 lifecycle 过滤（索引投影；缺省视为 active）。
   * 归档扫描用；不是 SessionStore 契约方法。
   */
  async listByLifecycle(
    lifecycle: NonNullable<SessionMeta['lifecycle']>,
  ): Promise<SessionMeta[]> {
    const entries = Object.values(await this.readMetaIndex());
    return entries.filter((e) => (e.lifecycle ?? 'active') === lifecycle);
  }

  async delete(sessionId: string): Promise<void> {
    await this.removeSessionFiles(sessionId);
    if (this.index) {
      try {
        await this.index.remove(sessionId);
      } catch {
        // 投影可重建
      }
    }
  }

  async exists(sessionId: string): Promise<boolean> {
    return (await fileExists(this.sessionFile(sessionId)))
      || (await fileExists(this.sessionStateFile(sessionId)));
  }
}
