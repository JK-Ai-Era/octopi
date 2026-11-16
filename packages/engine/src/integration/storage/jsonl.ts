/**
 * JsonlSessionStore — JSONL 文件存储（Session 一等）
 *
 * 唯一权威目录（与 agent home 解耦，无 legacy 回退）：
 *   <sessionsDir>/
 *     sessions.json          ← 所有 session 的元数据索引（键 = sessionId；含 lifecycle 投影）
 *     <sessionId>.jsonl      ← 对话记录（JSONL；save 整聚合快照写回，非磁盘 append-only）
 *     <sessionId>.state.json ← 附带状态（tasks / steps / metadata / 模型 2 字段）
 *
 * 主键 = sessionId；文件名一律 `toSessionFileName`（跨平台安全）。
 * 可选 `index`：可重建检索投影（失败不阻断权威写）。禁止把 index 当权威。
 * `sessions.json` parse 失败会拒绝写回，避免清空 meta。
 */

import { access, mkdir, readFile, writeFile, unlink, rename, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionStore, SessionListFilter } from '@octopi-agent/core/interfaces/session-store.js';
import { atomicTmpPath, atomicWriteFile } from './atomic-tmp.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import { DEFAULT_TENANT_ID } from '@octopi-agent/core/types.js';
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
 * 历史 state.json 的 turns[].input（全量历史快照；turns 为账本旧字段名）已废弃：读取即剥，turns 整键读入 steps，
 * 下次 save 自然瘦身。输入正文的唯一权威是 messages JSONL（Discourse）。
 *
 * 读取端宽松、写入端严格：legacy 账本可能缺 inputCount（旧格式无此字段），
 * rest spread 保全其余键，仅类型层面放宽；新写入的账本必含 inputCount。
 */
function slimSteps(steps: unknown): SessionData['steps'] {
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((t) => {
    if (!t || typeof t !== 'object') return [];
    const { input: _dropped, ...rest } = t as Record<string, unknown>;
    return [rest as unknown as SessionData['steps'][number]];
  });
}

/**
 * `sessions.json` 元索引 read-modify-write 串行队列，按 meta 文件路径在**进程内**
 * 共享（模块级：同进程多 store 实例也互斥——daemon 同进程就有双实例）。
 *
 * T5 演练实锤 2026-11-14：元索引是全店共享文件，per-session 的 withWriteLock 挡不住
 * 跨 session 并发 read-modify-write——读旧写旧丢条目，且截断直写曾让并发 delete 6ms
 * 即损坏整份元索引（评审 del-3c3fcfeb MAJ-1/2）。锁序恒为 session 锁 → meta 锁；
 * meta 锁内不取任何 session 锁，无死锁环。回归锚 tests/session-store-write-race.test.ts。
 *
 * 已知边界（勿当已闭）：**跨进程**窗口仍在——gateway 与 run-serve 子进程同写一份
 * sessions.json，本锁不跨进程；收口走 P2-1 session-serve 或 flock，登记
 * arch/multi-tenancy.md §9.1-14。
 *
 * @param metaPath - 元索引文件路径（锁键）
 * @param fn - 元索引 RMW 整段（read → mutate → write）
 * @returns fn 的结果
 */
const metaWriteQueues = new Map<string, Promise<void>>();

function withMetaLock<T>(metaPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = metaWriteQueues.get(metaPath) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  metaWriteQueues.set(
    metaPath,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
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
    tenantId?: SessionData['tenantId'];
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
    steps?: SessionData['steps'];
    metadata?: SessionData['metadata'];
  } | null> {
    const statePath = this.sessionStateFile(sessionId);
    if (!(await fileExists(statePath))) return null;
    try {
      const parsed = JSON.parse(await readFile(statePath, 'utf-8'));
      return { ...parsed, steps: slimSteps(parsed?.steps ?? parsed?.turns) };
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
    await atomicWriteFile(this.metaFile(), JSON.stringify(index, null, 2));
  }

  private buildIndexEntry(data: SessionData): SessionMeta {
    const participantAgentIds =
      data.meta.participantAgentIds ??
      (data.participants ?? []).map((p) => p.agentId);
    const lifecycle = data.lifecycle?.lifecycle ?? data.meta.lifecycle ?? 'active';
    return {
      ...data.meta,
      // 投影取值单一来源：SessionData.tenantId ?? meta.tenantId（legacy）；显式放 spread 后
      tenantId: data.tenantId ?? data.meta.tenantId,
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
      // 委派来源投影（D7）：历史隐藏子会话 / 父子归组（右栏"子会话"）依赖本字段；
      // 权威在 state.json 的 spawnBy（存量条目由 ensureSpawnLinkBackfill 补投影）
      spawnBy: data.spawnBy,
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
      tenantId?: SessionData['tenantId'];
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
      steps?: SessionData['steps'];
      metadata?: SessionData['metadata'];
    } = {};
    if (resolved.state) {
      try {
        const parsed = JSON.parse(await readFile(resolved.state, 'utf-8'));
        state = { ...parsed, steps: slimSteps(parsed?.steps ?? parsed?.turns) };
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
      tenantId: state.tenantId ?? meta?.tenantId,
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
      steps: state.steps ?? [],
      metadata: state.metadata ?? {},
      tasks: state.tasks ?? [],
    };
  }

  private async removeSessionFiles(sessionId: string): Promise<void> {
    // 元索引先摘（meta RMW 归锁 + 原子写）、数据文件后删（MAJ-1，评审 del-3c3fcfeb）：
    // 旧序「先删文件、后截断写回索引」曾让并发 delete 6ms 即损坏整份元索引，且读旧
    // 写回会复活/吞掉他人条目。新序 crash 只会留孤儿文件（磁盘清理兜底），不留幽灵
    // 条目。摘除失败如实上抛：吞错只会把「delete 假成功」和「索引损坏」都藏起来。
    const metaPath = this.metaFile();
    if (await fileExists(metaPath)) {
      await withMetaLock(metaPath, async () => {
        const allMeta = await this.readMetaIndex();
        delete allMeta[sessionId];
        await this.writeMetaIndex(allMeta);
      });
    }
    for (const p of [this.sessionFile(sessionId), this.sessionStateFile(sessionId)]) {
      if (await fileExists(p)) {
        await unlink(p);
      }
    }
    // OP-15：会话附件目录随 session 删除清理；转换记录同理（F6：摘要正文含用户内容）
    try {
      const { rm } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { toSessionFileName } = await import('@octopi-agent/core/session-filename.js');
      for (const dir of ['attachments', 'transform']) {
        await rm(join(this.sessionsDir, toSessionFileName(sessionId), dir), {
          recursive: true,
          force: true,
        });
      }
    } catch {
      // 附件/转换记录清理失败不阻断 session 删除；残留由磁盘清理兜底
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
      // tmp+rename 原子写（MAJ-2，评审 del-3c3fcfeb）：截断直写曾让并发 load 读到
      // 0 条消息（实测 254/320），load→save 放大链路会把转录永久清空
      await atomicWriteFile(this.sessionFile(sessionId), jsonl);
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

      await atomicWriteFile(this.sessionStateFile(sessionId), JSON.stringify({
        // 字段集必须与 updateMetadata() 的 state 重写保持一致：漏写即静默清字段
        tenantId: data.tenantId ?? data.meta.tenantId,
        agentId: data.agentId,
        primaryAgentId: data.primaryAgentId ?? data.agentId,
        preferredAgentId: data.preferredAgentId,
        switchAudit: data.switchAudit ?? [],
        // spawnBy 只增不清：陈旧整包 save（从零构造 SessionData）不得抹掉委派关联（D7），
        // 与 metadata 浅合并 / 标题仲裁同哲学；删关联不做（子会话归属是审计链）
        spawnBy: data.spawnBy ?? prevState?.spawnBy,
        participants: data.participants ?? [],
        contextDetachIndex: data.contextDetachIndex,
        contextCompact: data.contextCompact,
        contextCompacts: data.contextCompacts,
        lifecycle: data.lifecycle,
        tasks: data.tasks ?? [],
        steps: data.steps ?? [],
        metadata,
      }, null, 2));

      // 索引携带 lifecycle 投影：list 过滤 / 归档扫描不必打开 state

      // 索引最后更新：数据就绪才写入（meta RMW 进程内串行，见模块级 withMetaLock）
      await withMetaLock(this.metaFile(), async () => {
        const index = await this.readMetaIndex();
        index[sessionId] = this.buildIndexEntry({
          ...data,
          id: sessionId,
          metadata,
          // 与 state 写同口径：陈旧整包 save 不得抹掉委派关联投影
          spawnBy: data.spawnBy ?? prevState?.spawnBy,
        });
        await this.writeMetaIndex(index);
      });

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
      await atomicWriteFile(this.sessionStateFile(sessionId), JSON.stringify({
        tenantId: prev?.tenantId,
        agentId: prev?.agentId,
        // 字段集必须与 save() 的 state 重写保持一致：漏写即静默清字段
        //（contextDetachIndex 曾被漏掉——updateMetadata 后租约截断点归零，续跑全量灌窗；
        //  tenantId 曾被漏掉——load→save 一轮往返把租户会话擦进 default 桶）
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
        steps: prev?.steps ?? [],
        metadata,
      }, null, 2));

      try {
        await withMetaLock(this.metaFile(), async () => {
          const index = await this.readMetaIndex();
          const entry = index[sessionId];
          if (entry) {
            index[sessionId] = {
              ...entry,
              // pinnedAt 投影与 buildIndexEntry 同规则（置顶/取消即时可见于 list）
              pinnedAt: readPinnedAt(metadata.pinnedAt),
              // 委派关联投影同规则（MIN-5：只经历 updateMetadata 的会话也补投影）
              spawnBy: entry.spawnBy ?? prev?.spawnBy,
              // 标题投影同规则（rename / 自动标题即时可见于 list）
              ...readTitleState(metadata),
              updatedAt: Date.now(),
            };
            await this.writeMetaIndex(index);
          }
        });
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
      await atomicWriteFile(path, jsonl);
      this.noteSyncCache(sessionId, Buffer.byteLength(jsonl, 'utf-8'), messages.slice());
    });
  }

  /**
   * spawnBy 投影 backfill（每实例一次）：升级前落盘的会话其索引条目缺 `spawnBy`
   * （权威值在 state.json），历史隐藏子会话 / 父子归组依赖该投影。
   * 只补缺失条目，幂等；失败不阻断 list（显式降级 = 子会话暂在历史露出），
   * warn 后清缓存待下次 list 重试，不静默吞。
   */
  private spawnLinkBackfill?: Promise<void>;

  private ensureSpawnLinkBackfill(): Promise<void> {
    this.spawnLinkBackfill ??= this.backfillSpawnLinks().then(
      () => undefined,
      (err) => {
        this.spawnLinkBackfill = undefined;
        console.warn(
          `[JsonlSessionStore] spawnBy backfill failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
    return this.spawnLinkBackfill;
  }

  private async backfillSpawnLinks(): Promise<void> {
    const snapshot = await this.readMetaIndex();
    const missing = Object.values(snapshot).filter((e) => !e.spawnBy);
    if (missing.length === 0) return;
    // state 读取放锁外（只读；state 原子写保证不读到半截）；meta 锁内只做短 RMW 补写
    const patches = new Map<string, NonNullable<SessionData['spawnBy']>>();
    for (const entry of missing) {
      const spawnBy = (await this.readStateData(entry.id))?.spawnBy;
      if (spawnBy) patches.set(entry.id, spawnBy);
    }
    if (patches.size === 0) return;
    await withMetaLock(this.metaFile(), async () => {
      const index = await this.readMetaIndex();
      let changed = false;
      for (const [id, spawnBy] of patches) {
        const entry = index[id];
        if (entry && !entry.spawnBy) {
          entry.spawnBy = spawnBy;
          changed = true;
        }
      }
      if (changed) await this.writeMetaIndex(index);
    });
  }

  async list(filter?: SessionListFilter): Promise<SessionMeta[]> {
    await this.ensureSpawnLinkBackfill();
    let entries = Object.values(await this.readMetaIndex());
    if (filter?.tenantId) {
      const tenantId = filter.tenantId;
      // 历史缺省视作 'default'（multi-tenancy §5 渐进迁移）
      entries = entries.filter((e) => (e.tenantId ?? DEFAULT_TENANT_ID) === tenantId);
    }
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
