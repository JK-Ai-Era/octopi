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

import { access, mkdir, readFile, writeFile, unlink, rename, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionStore, SessionListFilter } from '@octopi-agent/core/interfaces/session-store.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { SessionMeta } from '@octopi-agent/core/types.js';
import { toSessionFileName } from '@octopi-agent/core/session-filename.js';
import { readTitleState, sessionMatchesAgent } from '@octopi-agent/core/types/session.js';
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

/** pinnedAt 投影：仅接受有限数值（epoch ms），其余视为未置顶 */
function readPinnedAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 已同步序列上限（LRU）：缓存只服务于增量判定，不得把全会话转录常驻钉在堆里 */
const MAX_SYNC_CACHES = 64;

/**
 * 已同步序列是否为给定序列的引用相等前缀。
 * 调用方契约：已同步消息不再原地修改（原地修改 = 视为新序列，须由调用方
 * 保证不发生在首同步之前，如 turn_start 定形）。
 */
function isRefPrefix(synced: readonly unknown[], incoming: readonly unknown[]): boolean {
  if (incoming.length < synced.length) return false;
  for (let i = 0; i < synced.length; i++) {
    if (synced[i] !== incoming[i]) return false;
  }
  return true;
}

/**
 * 历史 state.json 的 turns[].input（全量历史快照）已废弃：读取即剥，
 * 下次 save 自然瘦身。输入正文的唯一权威是 messages JSONL（Discourse）。
 *
 * 读取端宽松、写入端严格：legacy 账本可能缺 inputCount（旧格式无此字段），
 * rest spread 保全其余键，仅类型层面放宽；新写入的账本必含 inputCount。
 */
function slimTurns(turns: unknown): SessionData['turns'] {
  if (!Array.isArray(turns)) return [];
  return turns.flatMap((t) => {
    if (!t || typeof t !== 'object') return [];
    const { input: _dropped, ...rest } = t as Record<string, unknown>;
    return [rest as unknown as SessionData['turns'][number]];
  });
}

export class JsonlSessionStore implements SessionStore<SessionData> {
  private readonly sessionsDir: string;
  private readonly index?: SessionIndexSink;
  /** 同 sessionId 读改写串行（save / updateMetadata / syncMessages / delete） */
  private readonly writeQueues = new Map<string, Promise<void>>();
  /**
   * syncMessages 增量判定缓存：本实例最近一次写下的消息文件状态。
   * size（字节数）抓「旁路整包 save / 外部改动」造成的文件漂移；refs（消息对象
   * 引用序列）抓「同一实例的序列分歧」。任一不符即整文件对齐重写，自愈。
   * LRU 上限防长驻进程把全量转录引用常驻堆内存。
   */
  private readonly syncCaches = new Map<string, { size: number; refs: readonly unknown[] }>();

  /** 记录/刷新增量判定缓存（LRU：超限淘汰最旧条目） */
  private noteSyncCache(sessionId: string, size: number, refs: readonly unknown[]): void {
    this.syncCaches.delete(sessionId);
    if (this.syncCaches.size >= MAX_SYNC_CACHES) {
      const oldest = this.syncCaches.keys().next().value;
      if (oldest !== undefined) this.syncCaches.delete(oldest);
    }
    this.syncCaches.set(sessionId, { size, refs });
  }

  /**
   * @param options - sessionsDir + 可选 index
   */
  constructor(options: JsonlSessionStoreOptions) {
    this.sessionsDir = options.sessionsDir;
    this.index = options.index;
  }

  private withWriteLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.writeQueues.set(
      sessionId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async readStateData(sessionId: string): Promise<{
    agentId?: string;
    primaryAgentId?: string;
    preferredAgentId?: string;
    switchAudit?: SessionData['switchAudit'];
    spawnBy?: SessionData['spawnBy'];
    participants?: SessionData['participants'];
    contextDetachIndex?: SessionData['contextDetachIndex'];
    contextCompact?: SessionData['contextCompact'];
    contextCompacts?: SessionData['contextCompacts'];
    lifecycle?: SessionData['lifecycle'];
    tasks?: SessionData['tasks'];
    turns?: SessionData['turns'];
    metadata?: SessionData['metadata'];
  } | null> {
    const statePath = this.sessionStateFile(sessionId);
    if (!(await fileExists(statePath))) return null;
    try {
      const parsed = JSON.parse(await readFile(statePath, 'utf-8'));
      return { ...parsed, turns: slimTurns(parsed?.turns) };
    } catch {
      return null;
    }
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
      // 置顶是用户数据：权威在 metadata.pinnedAt（受 save 浅合并保护，
      // 长驻 run 对象的整包 save 抹不掉）；meta.pinnedAt 仅作旧数据回退
      pinnedAt: readPinnedAt(data.metadata?.pinnedAt) ?? readPinnedAt(data.meta.pinnedAt),
      // 标题是用户数据：权威在 metadata 三键（同 pinnedAt 通道，save 按 titleUpdatedAt 仲裁）；
      // 投影必须覆盖 ...data.meta 展开带出的陈旧 meta.title，不做旧数据回退
      ...readTitleState(data.metadata),
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
      spawnBy?: SessionData['spawnBy'];
      participants?: SessionData['participants'];
      contextDetachIndex?: SessionData['contextDetachIndex'];
      contextCompact?: SessionData['contextCompact'];
      contextCompacts?: SessionData['contextCompacts'];
      lifecycle?: SessionData['lifecycle'];
      tasks?: SessionData['tasks'];
      turns?: SessionData['turns'];
      metadata?: SessionData['metadata'];
    } = {};
    if (resolved.state) {
      try {
        const parsed = JSON.parse(await readFile(resolved.state, 'utf-8'));
        state = { ...parsed, turns: slimTurns(parsed?.turns) };
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
      spawnBy: state.spawnBy,
      participants: state.participants,
      contextDetachIndex: state.contextDetachIndex,
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
    // OP-15：会话附件目录随 session 删除清理
    try {
      const { rm } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { toSessionFileName } = await import('@octopi-agent/core/session-filename.js');
      await rm(join(this.sessionsDir, toSessionFileName(sessionId), 'attachments'), {
        recursive: true,
        force: true,
      });
    } catch {
      // 附件清理失败不阻断 session 删除；残留由磁盘清理兜底
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
    return this.withWriteLock(sessionId, async () => {
      await mkdir(this.sessionsDir, { recursive: true });

      // 写数据文件在前，索引在后：crash 时索引最多缺条目（load 仍能直接读文件），
      // 不会出现索引有但数据没写完的不一致
      const jsonl = data.messages.map(msg => JSON.stringify(msg)).join('\n') + '\n';
      await writeFile(this.sessionFile(sessionId), jsonl);
      // 全量重写后同步增量缓存（防止下一次 syncMessages 误判漂移）
      this.noteSyncCache(sessionId, Buffer.byteLength(jsonl, 'utf-8'), data.messages.slice());

      // metadata 浅合并：长驻 run 对象上的陈旧/空 metadata 不得抹掉
      // 并发 updateMetadata 写入的键（clientToolCalls / fileReleases…）。
      // 删键必须走 updateMetadata。
      const prevState = await this.readStateData(sessionId);
      const metadata = {
        ...(prevState?.metadata ?? {}),
        ...(data.metadata ?? {}),
      };
      // 标题三键按 titleUpdatedAt 仲裁：浅合并只护「缺键」，不护「旧值」——
      // 长驻 run 对象上 run 开始时的旧 trio 不得回滚运行期间 rename/标题生成写入的新 trio。
      // incoming 缺时间戳视为陈旧（写端恒打三键；缺戳 = 半写/外来写），同样归磁盘胜
      const fresh = readTitleState(prevState?.metadata);
      const incomingTitle = readTitleState(data.metadata);
      if (
        fresh.titleUpdatedAt !== undefined &&
        (incomingTitle.titleUpdatedAt === undefined ||
          incomingTitle.titleUpdatedAt < fresh.titleUpdatedAt)
      ) {
        metadata.title = fresh.title;
        metadata.titleSource = fresh.titleSource;
        metadata.titleUpdatedAt = fresh.titleUpdatedAt;
      }

      await writeFile(this.sessionStateFile(sessionId), JSON.stringify({
        agentId: data.agentId,
        primaryAgentId: data.primaryAgentId ?? data.agentId,
        preferredAgentId: data.preferredAgentId,
        switchAudit: data.switchAudit ?? [],
        spawnBy: data.spawnBy,
        participants: data.participants ?? [],
        contextDetachIndex: data.contextDetachIndex,
        contextCompact: data.contextCompact,
        contextCompacts: data.contextCompacts,
        lifecycle: data.lifecycle,
        tasks: data.tasks ?? [],
        turns: data.turns ?? [],
        metadata,
      }, null, 2));

      // 索引携带 lifecycle 投影：list 过滤 / 归档扫描不必打开 state

      // 索引最后更新：数据就绪才写入
      const index = await this.readMetaIndex();
      index[sessionId] = this.buildIndexEntry({ ...data, id: sessionId, metadata });
      await this.writeMetaIndex(index);

      // 可搜投影（失败不阻断；权威已落盘，可 rebuild）
      if (this.index) {
        try {
          await this.index.upsertFromSession(sessionId, { ...data, id: sessionId, metadata });
        } catch (err) {
          // 投影可重建，吞掉索引写失败（不拖垮权威 save）
          console.warn(
            `[JsonlSessionStore] session index upsert failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });
  }

  /**
   * metadata 原子读改写（含删键）。与 save 同会话串行。
   *
   * @param sessionId - 会话 id
   * @param mutate - 原地修改 meta，或返回替换对象；返回 undefined 表示用原地结果
   */
  async updateMetadata(
    sessionId: string,
    mutate: (meta: Record<string, unknown>) => void | Record<string, unknown>,
  ): Promise<void> {
    return this.withWriteLock(sessionId, async () => {
      const prev = await this.readStateData(sessionId);
      const hasMessages = await fileExists(this.sessionFile(sessionId));
      if (!prev && !hasMessages) return;

      const meta: Record<string, unknown> = { ...(prev?.metadata ?? {}) };
      const replaced = mutate(meta);
      const metadata = replaced === undefined ? meta : replaced;

      await mkdir(this.sessionsDir, { recursive: true });
      await writeFile(this.sessionStateFile(sessionId), JSON.stringify({
        agentId: prev?.agentId,
        // 字段集必须与 save() 的 state 重写保持一致：漏写即静默清字段
        //（contextDetachIndex 曾被漏掉——updateMetadata 后租约截断点归零，续跑全量灌窗）
        primaryAgentId: prev?.primaryAgentId ?? prev?.agentId,
        preferredAgentId: prev?.preferredAgentId,
        switchAudit: prev?.switchAudit ?? [],
        spawnBy: prev?.spawnBy,
        participants: prev?.participants ?? [],
        contextDetachIndex: prev?.contextDetachIndex,
        contextCompact: prev?.contextCompact,
        contextCompacts: prev?.contextCompacts,
        lifecycle: prev?.lifecycle,
        tasks: prev?.tasks ?? [],
        turns: prev?.turns ?? [],
        metadata,
      }, null, 2));

      try {
        const index = await this.readMetaIndex();
        const entry = index[sessionId];
        if (entry) {
          index[sessionId] = {
            ...entry,
            // pinnedAt 投影与 buildIndexEntry 同规则（置顶/取消即时可见于 list）
            pinnedAt: readPinnedAt(metadata.pinnedAt),
            // 标题投影同规则（rename / 自动标题即时可见于 list）
            ...readTitleState(metadata),
            updatedAt: Date.now(),
          };
          await this.writeMetaIndex(index);
        }
      } catch {
        // 索引投影可重建；metadata 权威已落盘
      }
    });
  }

  /**
   * 消息序列对齐（Run 进行中转录增量落盘）。契约见 SessionStore.syncMessages。
   *
   * 增量判定：文件字节数与上次本实例写入一致，且给定序列以已同步序列为
   * 引用相等前缀 → 只追加尾差；任一不成立（旁路整包 save / 外部改动 /
   * 前缀分歧 / 冷缓存）→ 整文件对齐重写。漂移不是错误路径：旁路写者
   * 整包 save 是常态动作，对齐即自愈。
   */
  async syncMessages(sessionId: string, messages: readonly unknown[]): Promise<void> {
    return this.withWriteLock(sessionId, async () => {
      await mkdir(this.sessionsDir, { recursive: true });
      const path = this.sessionFile(sessionId);
      const cache = this.syncCaches.get(sessionId);
      let size = -1;
      try {
        size = (await stat(path)).size;
      } catch {
        // 文件不存在 → 走整文件对齐
      }
      // 增量通道不是会话创建通道：会话完全不存在时跳过（创建/重建由 save 负责）
      if (size < 0 && !(await fileExists(this.sessionStateFile(sessionId)))) return;

      if (cache && size === cache.size && isRefPrefix(cache.refs, messages)) {
        const added = messages.slice(cache.refs.length);
        if (added.length === 0) return;
        const jsonl = added.map((m) => JSON.stringify(m)).join('\n') + '\n';
        await appendFile(path, jsonl);
        this.noteSyncCache(sessionId, size + Buffer.byteLength(jsonl, 'utf-8'), messages.slice());
        return;
      }

      // 整文件对齐走 tmp+rename：读侧（浏览器刷新 load）不得撞见写半截的转录
      const jsonl = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
      const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmpPath, jsonl);
      await rename(tmpPath, path);
      this.noteSyncCache(sessionId, Buffer.byteLength(jsonl, 'utf-8'), messages.slice());
    });
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
    return this.withWriteLock(sessionId, async () => {
      await this.removeSessionFiles(sessionId);
      this.syncCaches.delete(sessionId);
      if (this.index) {
        try {
          await this.index.remove(sessionId);
        } catch {
          // 投影可重建
        }
      }
    });
  }

  async exists(sessionId: string): Promise<boolean> {
    return (await fileExists(this.sessionFile(sessionId)))
      || (await fileExists(this.sessionStateFile(sessionId)));
  }
}
