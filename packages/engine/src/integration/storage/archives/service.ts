/**
 * 会话封存服务 —— 删除/归档/回收站统一机制的编排层
 *
 * 状态机（arch/session-archive-recycle.md §2）：
 *   热库 ──seal(trash)──▶ trashed ──到期/手动──▶ gone
 *   热库 ──seal(manual|auto)──▶ archived ──手动删除──▶ trashed / 恢复 ──▶ 热库
 *
 * 崩溃安全（§3.3）：seal 以旁车（`.staging/<base>.seal.json`）为界 ——
 * 旁车落盘前一切可整体回滚（旁车先于搬迁写，staging 有数据必有旁车）；
 * 旁车存在即 forward-to-complete（搬迁/purge/打包均幂等可重入）。
 * 不变式：任何崩溃点不会出现「热库无、包无」。
 *
 * 单写者纪律：注册表写入只经本类；组合侧（gateway 门面）持有唯一实例。
 *
 * @module
 */
import { mkdir, rename, rm, writeFile, cp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { toSessionFileName } from '@octopi-agent/core/session-filename.js';
import { sanitizeSessionDirName } from '../../providers/wire-dump.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { SessionMeta } from '@octopi-agent/core/types.js';
import {
  packBundle,
  removeBundle,
  unpackBundle,
  type BundleManifest,
  type BundleManifestInput,
} from './bundle.js';
import { ArchiveRegistry, type ArchiveRecord } from './registry.js';

/** 天毫秒 */
const DAY_MS = 86_400_000;

/** 封存来源/语义 */
export type SealedBy = 'manual' | 'trash' | 'auto';

/** 封存状态 */
export type ArchiveState = 'archived' | 'trashed';

/** 对外条目信息（注册表投影；UI/列表用） */
export interface ArchiveEntryInfo {
  sessionId: string;
  groupSealId: string;
  parentSessionId: string | null;
  state: ArchiveState;
  phase: ArchiveRecord['phase'];
  sealedBy: SealedBy;
  title: string;
  agentId: string;
  tenantId: string;
  createdAt: number | null;
  endedAt: number | null;
  sealedAt: number;
  purgeAt: number | null;
  bytes: number;
  messageCount: number;
  attachmentCount: number;
}

/** store 依赖面（JsonlSessionStore 满足；测试可换替身） */
export interface SessionArchiveStorePort {
  delete(sessionId: string, options?: { relocateTo?: string }): Promise<void>;
  load(sessionId: string): Promise<SessionData | null>;
  save(sessionId: string, data: SessionData): Promise<void>;
  listByLifecycle(lifecycle: 'active' | 'recent' | 'archived'): Promise<SessionMeta[]>;
  restoreMeta(meta: SessionMeta): Promise<void>;
}

/** schedules 依赖面 */
export interface SessionArchiveSchedulesPort {
  snapshotForArchive(sessionId: string): unknown[];
  purgeSession(sessionId: string): number;
  restoreForArchive(rows: unknown[]): void;
}

/** knowledge 依赖面（P0 仅封存侧 purge；恢复侧重登记 P1 起） */
export interface SessionArchiveKnowledgePort {
  /**
   * 封存时 purge 该会话全部 session 作用域源 + 可见性/命中（幂等）
   *
   * @param sessionId - 会话 id
   * @param sourceIds - manifest 记录的可检索 sourceId
   * @param agentId - 归属 agent
   */
  purgeSessionSources(sessionId: string, sourceIds: string[], agentId: string): Promise<void>;
  /**
   * 恢复时重登记（可选；缺省缺席 → RestoreResult.warnings 明示）
   *
   * @param sessionId - 会话 id
   * @param sources - manifest 记录的源映射
   * @returns 警告列表（空 = 全部成功）
   */
  restoreSessionSources?(
    sessionId: string,
    sources: Array<{ sourceId: string; attachmentFile?: string }>,
  ): Promise<string[]>;
}

/** 服务构造选项 */
export interface SessionArchiveServiceOptions {
  /** OCTOPI_HOME/sessions */
  sessionsDir: string;
  /** OCTOPI_HOME/archives（archives.db / sessions/<id>.tar.gz / .staging/） */
  archivesDir: string;
  store: SessionArchiveStorePort;
  schedules?: SessionArchiveSchedulesPort;
  knowledge?: SessionArchiveKnowledgePort;
  /** wire dump 根目录；缺省 = sessionsDir/../logs/llm-requests（自定义 dir 时显式传入） */
  wireDumpDir?: string;
  /** wire dump 随包封存（缺省 false = 封存时直接清除） */
  includeLlmDumps?: boolean;
  /** 回收站存期（天，缺省 30） */
  trashRetentionDays?: number;
  /** 自动冷归档（每日任务） */
  autoArchive?: {
    enabled?: boolean;
    recentRetentionDays?: number;
    forceDays?: number;
    retentionDays?: number;
  };
  /** 测试可控时钟 */
  now?: () => number;
}

/** seal 输入 */
export interface SealInput {
  sessionId: string;
  state: ArchiveState;
  sealedBy: SealedBy;
  /** 级联组（含自身；缺省单会话） */
  groupSessionIds?: string[];
  /** 覆盖到期时间（缺省按 sealedBy 派生） */
  purgeAt?: number | null;
}

/** seal 结果 */
export interface SealResult {
  sealed: ArchiveEntryInfo[];
}

/** restore 结果 */
export interface RestoreResult {
  restored: ArchiveEntryInfo[];
  warnings: string[];
}

/** purge 结果 */
export interface PurgeResult {
  purged: string[];
  warnings: string[];
}

/** reconcile 结果 */
export interface ReconcileReport {
  completedSeals: string[];
  completedRestores: string[];
  droppedRows: string[];
  warnings: string[];
}

/** retention 结果 */
export interface RetentionReport {
  purged: string[];
  /**
   * 自动冷归档候选（服务只提名，不代封存）：
   * 封存须走组合侧组级流程（关账 + spawnBy 级联 + 广播）—— 服务内直接 seal 会绕过
   * onClose 收尾、pending 取消与子会话级联（评审 major-3）
   */
  autoArchiveCandidates: string[];
  warnings: string[];
}

/** 封存旁车（`.staging/<base>.seal.json`；先于搬迁落盘） */
interface SealSidecar {
  version: 1;
  metaRaw: SessionMeta;
  schedules: unknown[];
  knowledgeSources: Array<{ sourceId: string; attachmentFile?: string }>;
  messageCount: number;
  attachmentCount: number;
  sealedAt: number;
  sealedBy: SealedBy;
  state: ArchiveState;
  purgeAt: number | null;
  groupSealId: string;
  parentSessionId: string | null;
  includeLlmDumps: boolean;
}

/** 会话封存服务 */
export class SessionArchiveService {
  private readonly registry: ArchiveRegistry;
  private readonly now: () => number;
  private readonly trashRetentionDays: number;
  private readonly autoArchive: Required<NonNullable<SessionArchiveServiceOptions['autoArchive']>>;
  private readonly wireDumpDir: string;

  constructor(private readonly opts: SessionArchiveServiceOptions) {
    this.registry = new ArchiveRegistry(join(opts.archivesDir, 'archives.db'));
    this.now = opts.now ?? Date.now;
    this.trashRetentionDays = opts.trashRetentionDays ?? 30;
    this.autoArchive = {
      enabled: opts.autoArchive?.enabled ?? true,
      recentRetentionDays: opts.autoArchive?.recentRetentionDays ?? 30,
      forceDays: opts.autoArchive?.forceDays ?? 90,
      retentionDays: opts.autoArchive?.retentionDays ?? 180,
    };
    this.wireDumpDir =
      opts.wireDumpDir ?? join(dirname(opts.sessionsDir), 'logs', 'llm-requests');
  }

  /** 关闭注册表句柄 */
  close(): void {
    this.registry.close();
  }

  // ── 串行互斥（评审 blocker-1）──
  // seal/restore/purge/trash/reconcile/retention 全部经此排队：
  // 并发双删/删除撞恢复会对同一 staging/包/tmp 交错写（后写覆盖先写或打出坏包），
  // 一次串行队列把整条状态机压成单线 [wis_7976a15f-038]。
  private opQueue: Promise<unknown> = Promise.resolve();

  /**
   * 串行执行一个封存操作（后到者等前一个完成；异常不阻断队列）
   *
   * @param fn - 操作体
   * @returns 操作结果
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opQueue.then(fn, fn);
    this.opQueue = run.catch(() => undefined);
    return run;
  }

  // ── 路径 ──

  private base(sessionId: string): string {
    return toSessionFileName(sessionId);
  }

  private bundleRel(sessionId: string): string {
    return `sessions/${this.base(sessionId)}.tar.gz`;
  }

  private bundlePath(sessionId: string): string {
    return join(this.opts.archivesDir, this.bundleRel(sessionId));
  }

  private stagingDir(sessionId: string): string {
    return join(this.opts.archivesDir, '.staging', this.base(sessionId));
  }

  private sidecarPath(sessionId: string): string {
    return join(this.opts.archivesDir, '.staging', `${this.base(sessionId)}.seal.json`);
  }

  private restoreStagingDir(sessionId: string): string {
    return join(this.opts.archivesDir, '.staging', `restore-${this.base(sessionId)}`);
  }

  private dumpDir(sessionId: string): string {
    // 与写入侧同源（wire-dump.ts sanitizeSessionDirName）：id 含 @/空格等字符时
    // 名字失配=封存时"直删"删不到，隐私残留继续存在（评审 major）
    return join(this.wireDumpDir, sanitizeSessionDirName(sessionId));
  }

  // ── seal ──

  /**
   * 封存（单会话或级联组）。组内逐会话 sealOne，同一 groupSealId、同一 purgeAt。
   * 组原子性（评审 major-2）：任一成员失败 → 回滚已完成成员（doRestore 幂等）后上抛，
   * 不留"父在包里、子在热库"的半组。
   *
   * @param input - 封存输入
   * @returns 封存条目
   * @throws 任一会话封存失败（回滚结果写进错误信息；回滚也失败的成员可经 restore 手动恢复）
   */
  async seal(input: SealInput): Promise<SealResult> {
    return this.serial(() => this.sealInner(input));
  }

  /** seal 串行体（runRetention 内部复用；不重新排队） */
  private async sealInner(input: SealInput): Promise<SealResult> {
    const ids = [...new Set([input.sessionId, ...(input.groupSessionIds ?? [])])];
    const sealedAt = this.now();
    const purgeAt =
      input.purgeAt !== undefined
        ? input.purgeAt
        : input.sealedBy === 'trash'
          ? sealedAt + this.trashRetentionDays * DAY_MS
          : input.sealedBy === 'auto'
            ? sealedAt + this.autoArchive.retentionDays * DAY_MS
            : null;
    const sealed: ArchiveEntryInfo[] = [];
    const done: string[] = [];
    try {
      for (const sessionId of ids) {
        sealed.push(
          await this.sealOne({
            sessionId,
            state: input.state,
            sealedBy: input.sealedBy,
            groupSealId: input.sessionId,
            parentSessionId: null,
            purgeAt,
            sealedAt,
          }),
        );
        done.push(sessionId);
      }
    } catch (err) {
      // 整组回滚（恢复已完成成员）；回滚失败的成员数据在包+注册表行，restore 可救
      const rolledBack: string[] = [];
      const stuck: string[] = [];
      for (const id of done) {
        try {
          await this.doRestore(id, { resuming: false });
          rolledBack.push(id);
        } catch {
          stuck.push(id);
        }
      }
      throw new Error(
        `group_partial: seal failed: ${(err as Error).message}; ` +
          `rolled back [${rolledBack.join(', ')}]` +
          (stuck.length > 0 ? `; ROLLBACK FAILED (restore manually) [${stuck.join(', ')}]` : ''),
      );
    }
    return { sealed };
  }

  /** seal 单会话全步骤（旁车 → 搬迁 → 副效应 → 打包 → 就绪） */
  private async sealOne(rec: {
    sessionId: string;
    state: ArchiveState;
    sealedBy: SealedBy;
    groupSealId: string;
    parentSessionId: string | null;
    purgeAt: number | null;
    sealedAt: number;
  }): Promise<ArchiveEntryInfo> {
    const { sessionId } = rec;
    // 0. 意图先落账（崩溃矩阵依据）
    this.registry.upsert({
      sessionId,
      groupSealId: rec.groupSealId,
      parentSessionId: rec.parentSessionId,
      tenantId: 'default',
      agentId: '',
      title: sessionId,
      state: rec.state,
      phase: 'sealing',
      sealedBy: rec.sealedBy,
      createdAt: null,
      endedAt: null,
      sealedAt: rec.sealedAt,
      purgeAt: rec.purgeAt,
      bundle: this.bundleRel(sessionId),
      bytes: 0,
      messageCount: 0,
      manifestJson: '{}',
    });
    // 1. 捕获旁车（快照先行：meta/schedules/knowledge 映射在破坏性步骤之前）
    const sidecar = await this.captureSidecar(sessionId, rec);
    await writeJsonAtomic(this.sidecarPath(sessionId), sidecar);
    // 2-8. forward-to-complete（可重入）
    await this.completeSeal(sessionId, sidecar);
    return toEntryInfo(this.registry.get(sessionId)!);
  }

  /** 捕获旁车（load 元数据 + schedules 快照 + 附件 manifest 的可检索映射） */
  private async captureSidecar(
    sessionId: string,
    rec: { state: ArchiveState; sealedBy: SealedBy; groupSealId: string; purgeAt: number | null; sealedAt: number },
  ): Promise<SealSidecar> {
    const data = await this.opts.store.load(sessionId);
    if (!data) throw new Error(`archive: session not found for seal: ${sessionId}`);
    const metaRaw = data.meta;
    const base = this.base(sessionId);
    // 附件 manifest：可检索映射 + 附件计数（热库侧读，搬迁前）
    let knowledgeSources: Array<{ sourceId: string; attachmentFile?: string }> = [];
    let attachmentCount = 0;
    const attachmentsManifest = join(this.opts.sessionsDir, base, 'attachments', 'manifest.json');
    if (existsSync(attachmentsManifest)) {
      try {
        const parsed = JSON.parse(await readFile(attachmentsManifest, 'utf-8')) as {
          items?: Array<{ path?: string; searchableSourceId?: string }>;
        };
        const items = parsed.items ?? [];
        attachmentCount = items.length;
        knowledgeSources = items
          .filter((i) => i.searchableSourceId)
          .map((i) => ({ sourceId: i.searchableSourceId!, attachmentFile: i.path }));
      } catch {
        // manifest 不可解析：可检索映射缺失 → knowledge 源靠 doctor 扫描兜底，不阻断封存
      }
    }
    return {
      version: 1,
      metaRaw,
      schedules: this.opts.schedules?.snapshotForArchive(sessionId) ?? [],
      knowledgeSources,
      messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
      attachmentCount,
      sealedAt: rec.sealedAt,
      sealedBy: rec.sealedBy,
      state: rec.state,
      purgeAt: rec.purgeAt,
      groupSealId: rec.groupSealId,
      parentSessionId:
        (data as SessionData).spawnBy?.parentSessionId ?? metaRaw?.spawnBy?.parentSessionId ?? null,
      includeLlmDumps: this.opts.includeLlmDumps === true,
    };
  }

  /** seal 的可重入主体（步骤 2-8；崩溃后 reconcile 以旁车为据重跑） */
  private async completeSeal(sessionId: string, sidecar: SealSidecar): Promise<void> {
    const staging = this.stagingDir(sessionId);
    // 2. 搬迁数据 → staging（含 meta 摘除 + 投影移除；rename 原子、EXDEV 退化 cp）
    await this.opts.store.delete(sessionId, { relocateTo: staging });
    // run 事件归档（`<sid>.events.jsonl`，gateway 门面写在 sessions/ 根）随包封存 ——
    // 漏网则 purge 后残留（评审 major-5）；命名与写入侧一致（原始 sessionId）
    const eventsPath = join(this.opts.sessionsDir, `${sessionId}.events.jsonl`);
    if (existsSync(eventsPath)) {
      await movePath(eventsPath, join(staging, 'events.jsonl'));
    }
    // 硬校验：搬迁后会话数据必须在 staging（防 store 吞 relocateTo 打出空包丢正文；
    // jsonl/state 二者至少其一——二者皆无的会话在 capture 阶段即以 not found 拒绝）
    if (
      !existsSync(join(staging, `${this.base(sessionId)}.jsonl`)) &&
      !existsSync(join(staging, `${this.base(sessionId)}.state.json`))
    ) {
      throw new Error(
        `archive: relocate failed — session data missing in staging after store.delete (store must honor relocateTo)`,
      );
    }
    // 3. wire dump：入包（配置开）或直接清除（缺省；诊断衍生品不进回收站）
    const dump = this.dumpDir(sessionId);
    if (existsSync(dump)) {
      if (sidecar.includeLlmDumps) {
        await movePath(dump, join(staging, 'llm-dumps'));
      } else {
        await rm(dump, { recursive: true, force: true });
      }
    }
    // 4. schedules purge（幂等）+ 5. knowledge purge（幂等）
    if (this.opts.schedules) this.opts.schedules.purgeSession(sessionId);
    if (this.opts.knowledge) {
      await this.opts.knowledge.purgeSessionSources(
        sessionId,
        sidecar.knowledgeSources.map((k) => k.sourceId),
        String(sidecar.metaRaw.agentId ?? ''),
      );
    }
    // 6. 打包（tmp+rename；manifest = 旁车 + 逐文件 sha256/stats）
    const manifestInput: BundleManifestInput = {
      sessionId,
      tenantId: sidecar.metaRaw.tenantId,
      agentId: String(sidecar.metaRaw.agentId ?? ''),
      title: String(sidecar.metaRaw.title ?? sessionId),
      sealedAt: sidecar.sealedAt,
      sealedBy: sidecar.sealedBy,
      state: sidecar.state,
      purgeAt: sidecar.purgeAt,
      parentSessionId: sidecar.parentSessionId ?? undefined,
      groupSealId: sidecar.groupSealId,
      metaRaw: sidecar.metaRaw,
      schedules: sidecar.schedules,
      knowledgeSources: sidecar.knowledgeSources,
      stats: { messageCount: sidecar.messageCount, attachmentCount: sidecar.attachmentCount },
    };
    const manifest = await packBundle({
      stagingDir: staging,
      outPath: this.bundlePath(sessionId),
      manifest: manifestInput,
    });
    // 7. 就绪入账（bytes/messageCount/manifest 缓存）
    const prev = this.registry.get(sessionId)!;
    this.registry.upsert({
      ...prev,
      parentSessionId: sidecar.parentSessionId,
      tenantId: String(sidecar.metaRaw.tenantId ?? prev.tenantId),
      agentId: String(sidecar.metaRaw.agentId ?? prev.agentId),
      title: manifest.title,
      createdAt: sidecar.metaRaw.createdAt ?? null,
      endedAt: sidecar.metaRaw.endedAt ?? null,
      phase: 'ready',
      bytes: manifest.stats.bytes,
      messageCount: manifest.stats.messageCount,
      manifestJson: JSON.stringify(manifest),
    });
    // 8. 清 staging + 旁车
    await rm(staging, { recursive: true, force: true });
    await rm(this.sidecarPath(sessionId), { force: true });
  }

  /**
   * 归档 → 回收站（改标 trashed + trashRetentionDays 到期；级联组整组）
   *
   * @param sessionId - 组内任一会话 id
   * @returns 改标后的条目
   * @throws 未封存 / 封存未就绪（entry_not_ready）
   */
  async trash(sessionId: string): Promise<ArchiveEntryInfo[]> {
    return this.serial(async () => {
      const row = this.registry.get(sessionId);
      if (!row) throw new Error(`archive: not found: ${sessionId}`);
      // phase 守卫（评审 blocker-2）：sealing 行改标后会进 TTL 自动销毁路径，
      // 而其正文可能只在 staging（包未打）—— 到期 purge 即丢正文
      if (row.phase !== 'ready') {
        throw new Error(`entry_not_ready: "${sessionId}" is in phase ${row.phase}; cannot trash before it settles`);
      }
      const purgeAt = this.now() + this.trashRetentionDays * DAY_MS;
      const group = this.registry.listByGroup(row.groupSealId);
      for (const r of group) {
        this.registry.setState(r.sessionId, 'trashed', purgeAt);
      }
      return this.registry.listByGroup(row.groupSealId).map(toEntryInfo);
    });
  }

  // ── restore ──

  /**
   * 恢复（按级联组整组解封回热库）
   *
   * @param sessionId - 组内任一会话 id
   * @returns 恢复条目 + 警告（knowledge 重登记缺位等显式降级）
   * @throws 包缺失且无 staging 可回放时上抛（fail loud）；sealing 未就绪 / id 冲突拒绝
   */
  async restore(sessionId: string): Promise<RestoreResult> {
    return this.serial(() => this.restoreInner(sessionId));
  }

  /** restore 串行体（reconcile 续传走 doRestore，不重新排队） */
  private async restoreInner(sessionId: string): Promise<RestoreResult> {
    const row = this.registry.get(sessionId);
    if (!row) throw new Error(`archive: not found: ${sessionId}`);
    // phase 守卫（评审 blocker-2/major-1）：sealing 行的 manifest 是占位 '{}'、正文可能
    // 只在 staging —— 恢复走死路，还会把行改标 restoring 让 reconcile 的续封分支永远救不回
    if (row.phase === 'sealing') {
      throw new Error(
        `entry_not_ready: "${sessionId}" is still sealing; let startup reconcile settle it first`,
      );
    }
    const group = this.registry.listByGroup(row.groupSealId);
    // 全组 id 冲突守卫（评审 major-8）：任一成员热库已有同 id 会话（删除后 id 被复用）→
    // 整组拒绝，防 skip-if-exists 把新旧数据混合（只查根不够）
    for (const member of group) {
      if (member.phase === 'restoring') continue; // 崩溃续传：热库半程数据属于本次恢复
      if (await this.opts.store.load(member.sessionId)) {
        throw new Error(
          `session_id_conflict: a live session "${member.sessionId}" exists; cannot restore the sealed copy onto it`,
        );
      }
    }
    const warnings: string[] = [];
    const restored: ArchiveEntryInfo[] = [];
    for (const r of group) {
      const resuming = r.phase === 'restoring';
      this.registry.setPhase(r.sessionId, 'restoring');
      warnings.push(...(await this.doRestore(r.sessionId, { resuming })));
      // doRestore 尾部已删行；结果条目取恢复前的注册表快照（归档档案身份）
      restored.push(toEntryInfo(r));
    }
    return { restored, warnings };
  }

  /** restore 单会话可重入主体（unpack → 搬回 → meta/投影重建 → schedules 回插 → 清理） */
  private async doRestore(sessionId: string, opts: { resuming: boolean }): Promise<string[]> {
    const warnings: string[] = [];
    const row = this.registry.get(sessionId);
    if (!row) return warnings;
    const manifest = JSON.parse(row.manifestJson) as BundleManifest;
    // manifest 结构 + 身份校验（评审 major-1/minor）：sealing 行的 manifestJson 是占位 '{}'，
    // 裸访问 .knowledgeSources 会 TypeError；包被互换（A 包配 B 行）也在此拦
    if (
      !manifest ||
      !Array.isArray(manifest.files) ||
      !Array.isArray(manifest.schedules) ||
      !Array.isArray(manifest.knowledgeSources) ||
      manifest.sessionId !== sessionId
    ) {
      throw new Error(`bundle_manifest_invalid: cannot restore "${sessionId}"`);
    }
    const staging = this.restoreStagingDir(sessionId);
    const hotBase = this.base(sessionId);
    // 1. 解包到恢复 staging（包在即重解；每次恢复以校验过的落盘为准）
    const bundle = this.bundlePath(sessionId);
    if (existsSync(bundle)) {
      await rm(staging, { recursive: true, force: true });
      const unpacked = await unpackBundle(bundle, staging);
      // 包身份校验（评审 minor+换包场景）：包内 manifest 与行必须是同一会话 ——
      // 误换包时 sha 自洽、unpack 不报错，只有这道闸能拦住"把 B 的转录写进 A"
      if (unpacked.sessionId !== sessionId) {
        throw new Error(
          `bundle_manifest_invalid: bundle for "${sessionId}" contains session "${unpacked.sessionId}"`,
        );
      }
    } else if (!existsSync(staging)) {
      // 恢复尾崩窗口（评审 major-7）：包已删、行未删 —— 热库有会话 = 恢复实际已完成，
      // 补清行即收尾；热库也没有才是真丢失
      const live = await this.opts.store.load(sessionId);
      if (live) {
        this.registry.remove(sessionId);
        return warnings;
      }
      throw new Error(
        `archive: bundle and restore staging both missing for ${sessionId}; cannot restore (manual recovery required)`,
      );
    }
    // 2. 搬回热库（rename 原子；续传跳过已搬路径；非续传遇 dest 已存在=id 冲突，拒绝混合）
    const targets: Array<[string, string]> = [
      [join(staging, `${hotBase}.jsonl`), join(this.opts.sessionsDir, `${hotBase}.jsonl`)],
      [join(staging, `${hotBase}.state.json`), join(this.opts.sessionsDir, `${hotBase}.state.json`)],
    ];
    for (const dir of ['attachments', 'transform', 'derived']) {
      targets.push([
        join(staging, dir),
        join(this.opts.sessionsDir, hotBase, dir),
      ]);
    }
    targets.push([join(staging, 'llm-dumps'), this.dumpDir(sessionId)]);
    targets.push([
      join(staging, 'events.jsonl'),
      join(this.opts.sessionsDir, `${sessionId}.events.jsonl`),
    ]);
    for (const [src, dest] of targets) {
      if (existsSync(dest)) {
        if (!opts.resuming) {
          throw new Error(
            `session_id_conflict: "${dest}" already exists during restore of "${sessionId}"; refusing to mix sealed and live data`,
          );
        }
        continue; // 续传：已搬回的跳过
      }
      if (existsSync(src)) {
        await movePath(src, dest);
      }
    }
    // 3. meta 回填 + load/save 重建索引投影（metaRaw 先行：save 的 buildIndexEntry 以它为底）
    const meta = (manifest as BundleManifest & { metaRaw?: SessionMeta }).metaRaw;
    if (meta) {
      await this.opts.store.restoreMeta(meta);
    } else {
      warnings.push(`archive: ${sessionId} manifest 缺 metaRaw，恢复后元字段回退为默认值`);
    }
    const data = await this.opts.store.load(sessionId);
    if (!data) {
      // 热库未物化（清单/包不一致、文件名对不上）：绝不带病删包 —— 包是唯一完整副本
      throw new Error(
        `archive: restore incomplete for "${sessionId}": hot copy not materialized; bundle kept for retry`,
      );
    }
    await this.opts.store.save(sessionId, data);
    // 4. schedules 回插（幂等）
    if (this.opts.schedules && Array.isArray(manifest.schedules)) {
      this.opts.schedules.restoreForArchive(manifest.schedules as never[]);
    }
    // 5. knowledge 重登记（P1 起有实现；缺位显式降级）
    if (manifest.knowledgeSources.length > 0) {
      if (this.opts.knowledge?.restoreSessionSources) {
        warnings.push(
          ...(await this.opts.knowledge.restoreSessionSources(sessionId, manifest.knowledgeSources)),
        );
      } else {
        warnings.push(
          `archive: ${sessionId} 的 ${manifest.knowledgeSources.length} 个可检索附件源需重开「可恢复检索」（P1 起自动重登记）`,
        );
      }
    }
    // 6. 清包 + 注册表行 + 恢复 staging
    await removeBundle(bundle);
    await rm(staging, { recursive: true, force: true });
    this.registry.remove(sessionId);
    return warnings;
  }

  // ── purge ──

  /**
   * 彻底删除（按级联组整组销毁：包 + 残余 + 注册表行）
   *
   * @param sessionId - 组内任一会话 id
   * @returns 销毁清单 + 警告
   */
  async purge(sessionId: string): Promise<PurgeResult> {
    return this.serial(() => this.purgeInner(sessionId));
  }

  /** purge 串行体（runRetention 复用；不重新排队） */
  private async purgeInner(sessionId: string): Promise<PurgeResult> {
    const row = this.registry.get(sessionId);
    if (!row) throw new Error(`archive: not found: ${sessionId}`);
    // phase 守卫（评审 blocker-2）：sealing/restoring 行的正文可能只在 staging（唯一副本），
    // 销毁 staging+旁车 = 永久丢正文。只允许销毁 ready（包为权威）的行
    if (row.phase !== 'ready') {
      throw new Error(
        `entry_not_ready: cannot purge "${sessionId}" in phase ${row.phase}; its only copy may be in staging (reconcile first)`,
      );
    }
    const group = this.registry.listByGroup(row.groupSealId);
    // 组级 ready 守卫：入口行 ready 不代表兄弟行就绪（崩溃恢复中的组会混相），
    // 组销毁会连带清 staging/旁车 —— 任一成员未就绪则整组拒销，交 reconcile 先结清
    const unsettled = group.filter((r) => r.phase !== 'ready');
    if (unsettled.length > 0) {
      throw new Error(
        `entry_not_ready: group "${row.groupSealId}" has unsettled members (${unsettled
          .map((r) => `${r.sessionId}=${r.phase}`)
          .join(', ')}); reconcile before purge`,
      );
    }
    const purged: string[] = [];
    const warnings: string[] = [];
    for (const r of group) {
      // 组销毁（评审 major-2）：purge 不可逆、失败即停，已销毁清单如实上报（不假装整组成功）
      warnings.push(...(await this.doPurge(r.sessionId)));
      purged.push(r.sessionId);
    }
    return { purged, warnings };
  }

  /** purge 单会话可重入主体 */
  private async doPurge(sessionId: string): Promise<string[]> {
    const warnings: string[] = [];
    const row = this.registry.get(sessionId);
    if (!row) return warnings;
    // knowledge 防御性再 purge（幂等；正常已在 seal 时清）
    try {
      const manifest = JSON.parse(row.manifestJson) as BundleManifest;
      if (this.opts.knowledge && manifest.knowledgeSources?.length) {
        await this.opts.knowledge.purgeSessionSources(
          sessionId,
          manifest.knowledgeSources.map((k) => k.sourceId),
          String(manifest.agentId ?? ''),
        );
      }
    } catch {
      warnings.push(`archive: ${sessionId} manifest 不可解析，knowledge 源防御性 purge 跳过`);
    }
    await removeBundle(this.bundlePath(sessionId));
    await rm(this.stagingDir(sessionId), { recursive: true, force: true });
    await rm(this.sidecarPath(sessionId), { force: true });
    await rm(this.restoreStagingDir(sessionId), { recursive: true, force: true });
    await rm(this.dumpDir(sessionId), { recursive: true, force: true });
    await rm(join(this.opts.sessionsDir, `${sessionId}.events.jsonl`), { force: true });
    await rmdirQuiet(join(this.opts.sessionsDir, this.base(sessionId)));
    this.registry.remove(sessionId);
    return warnings;
  }

  // ── list ──

  /**
   * 列出封存条目
   *
   * @param state - 状态过滤（缺省全部）
   * @returns 条目列表（sealedAt 倒序）
   */
  list(state?: ArchiveState): ArchiveEntryInfo[] {
    return this.registry.list(state).map(toEntryInfo);
  }

  // ── reconcile ──

  /**
   * 启动/崩溃后对账（幂等）：
   * - sealing + 旁车 → forward-to-complete
   * - sealing + 包在 → 补就绪（清 staging）
   * - sealing + 全空 → 撤行（操作没发生过）
   * - restoring → 重跑 doRestore（skip-if-exists 续传）
   *
   * @returns 对账报告
   */
  /**
   * 读注册表 meta 键（组合侧调度状态，如 retention.lastRun）
   *
   * @param key - 键名
   * @returns 值；不存在返回 null
   */
  getMeta(key: string): string | null {
    return this.registry.getMeta(key);
  }

  /**
   * 写注册表 meta 键（upsert）
   *
   * @param key - 键名
   * @param value - 值
   */
  setMeta(key: string, value: string): void {
    this.registry.setMeta(key, value);
  }

  async reconcile(): Promise<ReconcileReport> {
    return this.serial(() => this.reconcileInner());
  }

  /** reconcile 串行体 */
  private async reconcileInner(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      completedSeals: [],
      completedRestores: [],
      droppedRows: [],
      warnings: [],
    };
    for (const row of this.registry.listUnsettled()) {
      const sessionId = row.sessionId;
      try {
        if (row.phase === 'restoring') {
          await this.doRestore(sessionId, { resuming: true });
          report.completedRestores.push(sessionId);
          continue;
        }
        // phase = sealing
        const sidecarPath = this.sidecarPath(sessionId);
        if (existsSync(sidecarPath)) {
          const sidecar = JSON.parse(await readFile(sidecarPath, 'utf-8')) as SealSidecar;
          await this.completeSeal(sessionId, sidecar);
          report.completedSeals.push(sessionId);
        } else if (existsSync(this.bundlePath(sessionId))) {
          const prev = this.registry.get(sessionId)!;
          this.registry.upsert({ ...prev, phase: 'ready' });
          await rm(this.stagingDir(sessionId), { recursive: true, force: true });
          report.completedSeals.push(sessionId);
        } else if (!existsSync(this.stagingDir(sessionId))) {
          // 旁车/包/staging 全空 = 意图落账后未动工：撤行即回滚
          this.registry.remove(sessionId);
          report.droppedRows.push(sessionId);
        } else {
          // staging 有数据但旁车缺失：不猜测、不乱动（防双写覆盖），交 doctor 定位
          report.warnings.push(
            `archive: ${sessionId} staging present but sidecar missing — kept untouched for doctor inspection`,
          );
        }
      } catch (err) {
        report.warnings.push(`archive: reconcile ${sessionId} failed: ${(err as Error).message}`);
      }
    }
    // 尾扫：row=ready 但 staging/旁车残留 =「就绪入账后、清场前」崩溃 —— 包是权威，安全清除；
    // 无行的 staging 不猜不动（交 doctor）。
    for (const row of this.registry.listReady()) {
      await rm(this.stagingDir(row.sessionId), { recursive: true, force: true });
      await rm(this.sidecarPath(row.sessionId), { force: true });
      await rm(this.restoreStagingDir(row.sessionId), { recursive: true, force: true });
    }
    return report;
  }

  // ── retention（每日任务） ──

  /**
   * 到期清除 + 自动冷归档候选提名（幂等；漏跑补跑以 purgeAt 比较为准）。
   * 自动封存不在本服务执行：封存须走组合侧组级流程（关账 + spawnBy 级联 + 广播），
   * 服务内直接 seal 会绕过 onClose 收尾与级联（评审 major-3）。
   *
   * @param now - 覆盖当前时间（测试用）
   * @param skip - 跳过谓词（组合侧传入：如 run 在途的会话不做自动封存）
   * @returns 执行报告（autoArchiveCandidates 待组合侧逐个组封存）
   */
  async runRetention(
    now = this.now(),
    skip?: (sessionId: string) => boolean,
  ): Promise<RetentionReport> {
    return this.serial(async () => {
      const report: RetentionReport = { purged: [], autoArchiveCandidates: [], warnings: [] };
      // 1. 回收站到期整组销毁（只列 ready；非 ready 的唯一副本可能在 staging，purgeInner 拒收）
      const seenGroups = new Set<string>();
      for (const row of this.registry.listExpiredTrashed(now)) {
        if (seenGroups.has(row.groupSealId)) continue;
        seenGroups.add(row.groupSealId);
        try {
          const { purged } = await this.purgeInner(row.sessionId);
          report.purged.push(...purged);
        } catch (err) {
          report.warnings.push(`archive: purge ${row.groupSealId} failed: ${(err as Error).message}`);
        }
      }
      // 2. 自动冷归档候选（recent 超期 / 活跃静默超期；在跑 run 的会话由 skip 谓词过滤）
      if (this.autoArchive.enabled) {
        const recentCutoff = now - this.autoArchive.recentRetentionDays * DAY_MS;
        const forceCutoff = now - this.autoArchive.forceDays * DAY_MS;
        const candidates: Array<{ sessionId: string }> = [];
        for (const meta of await this.opts.store.listByLifecycle('recent')) {
          const ended = meta.endedAt ?? meta.lastInteractionAt ?? 0;
          if (ended > 0 && ended < recentCutoff) candidates.push({ sessionId: meta.id });
        }
        for (const meta of await this.opts.store.listByLifecycle('active')) {
          const last = meta.lastInteractionAt ?? 0;
          if (last > 0 && last < forceCutoff) candidates.push({ sessionId: meta.id });
        }
        for (const c of candidates) {
          if (skip?.(c.sessionId)) {
            report.warnings.push(`archive: auto-archive ${c.sessionId} skipped (in-flight run)`);
            continue;
          }
          report.autoArchiveCandidates.push(c.sessionId);
        }
      }
      return report;
    });
  }
}

// ── 小工具 ──

/** 注册表行 → 对外条目 */
function toEntryInfo(rec: ArchiveRecord): ArchiveEntryInfo {
  // attachmentCount 只在 manifest 缓存里（stats）；缓存不可解析时降级 0（真实失败兜底，
  // 不是占位——正常路径下 manifestJson 由本类写入必为合法 JSON）
  let attachmentCount = 0;
  try {
    const parsed = JSON.parse(rec.manifestJson) as { stats?: { attachmentCount?: number } };
    attachmentCount = parsed.stats?.attachmentCount ?? 0;
  } catch {
    // swallow: 缓存读侧唯一失败面 = 历史坏行；包内清单仍是权威，列表展示降级不阻塞
  }
  return {
    sessionId: rec.sessionId,
    groupSealId: rec.groupSealId,
    parentSessionId: rec.parentSessionId ?? null,
    state: rec.state,
    phase: rec.phase,
    sealedBy: rec.sealedBy,
    title: rec.title,
    agentId: rec.agentId,
    tenantId: rec.tenantId,
    createdAt: rec.createdAt ?? null,
    endedAt: rec.endedAt ?? null,
    sealedAt: rec.sealedAt,
    purgeAt: rec.purgeAt ?? null,
    bytes: rec.bytes,
    messageCount: rec.messageCount,
    attachmentCount,
  };
}

/** 原子写 JSON（tmp+rename） */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 1), 'utf-8');
  await rename(tmp, path);
}

/** 搬移路径（rename 优先，EXDEV 退化 cp+rm） */
async function movePath(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await cp(src, dest, { recursive: true });
    await rm(src, { recursive: true, force: true });
  }
}

/** 静默移除空目录（非空/不存在忽略） */
async function rmdirQuiet(dir: string): Promise<void> {
  try {
    const { rmdir } = await import('node:fs/promises');
    await rmdir(dir);
  } catch {
    // 非空/不存在：保留待 doctor 或本就无事
  }
}
