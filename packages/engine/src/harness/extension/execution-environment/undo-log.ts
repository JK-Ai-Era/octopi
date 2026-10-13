/**
 * Turn 文件 undo（ToolEffectPolicy L3）
 *
 * 即时生效 + 本轮 undo log：工具写立刻落盘，同时记录写前字节。
 * 「编辑重发」discard 只逆放 agent 工具效应；用户手改保留。
 * 落盘：`sessions/<sid>/undo/`（与 attachments 同级，不进 agent home / workspace）。
 *
 * 统一效应账本：可逆条目进 log.jsonl（有 before）；不可逆只进 notReversed 结果。
 * 见 arch/tool-effect-policy.md §5.6。
 */

import { createHash } from 'node:crypto';
import {
  appendFile as fsAppendFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { toSessionFileName } from '@octopi-agent/core/session-filename.js';
import type { ToolFileEffects } from '@octopi-agent/core/types/tools.js';
import type { MemoryEffectJournal } from '@octopi-agent/core/types/tools.js';
import { isProbablyText, pathKey, reverseAgentOverwrite } from './undo-merge.js';
import {
  TurnMemoryJournal,
  discardMemoryUndo,
  type DiscardMemoryEffectsResult,
  type MemoryEffectRestorer,
} from './memory-undo.js';

/** undo 目录布局 */
export interface SessionUndoPaths {
  /** `sessions/<sid>/undo` */
  root: string;
  logPath: string;
  blobsDir: string;
}

/**
 * 解析会话 undo 目录
 *
 * @param sessionsDir - 通常 `OCTOPI_HOME/sessions`
 * @param sessionId - 会话 id
 * @returns 路径
 */
export function resolveSessionUndoPaths(sessionsDir: string, sessionId: string): SessionUndoPaths {
  const root = join(sessionsDir, toSessionFileName(sessionId), 'undo');
  return {
    root,
    logPath: join(root, 'log.jsonl'),
    blobsDir: join(root, 'blobs'),
  };
}

/** 落盘条目（按路径 coalesce） */
export type FileUndoEntry =
  | { op: 'create'; path: string; afterHash: string; afterRef?: string }
  | {
      op: 'overwrite';
      path: string;
      beforeRef: string;
      afterHash: string;
      afterRef?: string;
      /** 最后工具效应为删除 */
      agentDeleted?: boolean;
    }
  | { op: 'delete'; path: string; beforeRef: string; agentDeleted?: boolean };

export type DiscardConflictReason =
  | 'merge_conflict'
  | 'binary_user_wins'
  | 'user_deleted'
  | 'user_recreated'
  | 'budget_truncated';

export type NotReversedReason =
  | 'inventory_only'
  | 'budget_truncated'
  | 'no_roots'
  | 'shell_journal_off';

/** 不可逆效应（无 before / 未记账）；宿主可见，不进 LLM 历史 */
export interface NotReversedEffects {
  reason: NotReversedReason;
  created?: string[];
  modified?: string[];
  deleted?: string[];
}

/** 编辑重发效应逆放结果（对外即 EditResendResult） */
export interface EditResendResult {
  discarded: Array<{ path: string; action: 'deleted' | 'restored' }>;
  keptUserEdits: Array<{ path: string; reason: DiscardConflictReason }>;
  /** 本 turn 不可逆效应（shell 等） */
  notReversed?: NotReversedEffects;
  /** undoLimit / 预算撞顶：回滚不完整 */
  truncated?: boolean;
  entries: number;
  /** 记忆面逆放（P2） */
  memory: DiscardMemoryEffectsResult;
}

export type DiscardFileEffectsResult = EditResendResult;

/** undo 配额（缺省不限；撞顶后停记 before，业务写继续） */
export interface UndoLimitConfig {
  maxEntries?: number;
  maxBlobBytes?: number;
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function toBytes(data: string | Uint8Array): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

interface CoalescedEntry {
  op: 'create' | 'overwrite' | 'delete';
  path: string;
  beforeRef?: string;
  afterHash: string;
  afterRef?: string;
  /** 最后一次工具效应是否为删除（决定缺失文件是恢复还是 user_deleted） */
  agentDeleted: boolean;
  seq: number;
}

/**
 * 本轮文件 undo log — 实现 `ToolFileEffects`
 */
export class TurnFileUndoLog implements ToolFileEffects {
  private readonly paths: SessionUndoPaths;
  private readonly entriesByPath = new Map<string, CoalescedEntry>();
  private seq = 0;
  private sealed = false;
  /** flush 串行：并行工具写盘不得丢条目 */
  private flushChain: Promise<void> = Promise.resolve();
  private readonly limit?: UndoLimitConfig;
  private blobBytes = 0;
  private limitHit = false;
  /** 记忆面 journal（P2）；与文件共用 undo 根 */
  readonly memoryJournal: TurnMemoryJournal;

  private constructor(paths: SessionUndoPaths, limit?: UndoLimitConfig) {
    this.paths = paths;
    this.limit = limit;
    this.memoryJournal = new TurnMemoryJournal(paths.root);
  }

  /** ToolExecutionContext.memoryEffects */
  get memoryEffects(): MemoryEffectJournal {
    return this.memoryJournal;
  }

  /** undoLimit 是否已截断 */
  get truncated(): boolean {
    return this.limitHit;
  }

  /**
   * 开始本轮 undo。若已有残留 log（上一轮中止后继续对话），先 commit。
   *
   * @param options - sessionsDir + sessionId + 可选 undoLimit
   * @returns 日志实例
   */
  static async begin(options: {
    sessionsDir: string;
    sessionId: string;
    undoLimit?: UndoLimitConfig;
  }): Promise<TurnFileUndoLog> {
    const paths = resolveSessionUndoPaths(options.sessionsDir, options.sessionId);
    if (await pathExists(paths.root)) {
      await rm(paths.root, { recursive: true, force: true });
    }
    await mkdir(paths.blobsDir, { recursive: true });
    const log = new TurnFileUndoLog(paths, options.undoLimit);
    await log.flushLog();
    return log;
  }

  get root(): string {
    return this.paths.root;
  }

  get size(): number {
    return this.entriesByPath.size;
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await this.recordWrite(path, data, 'overwrite');
  }

  async appendFile(path: string, data: string | Uint8Array): Promise<void> {
    await this.recordWrite(path, data, 'append');
  }

  /** 删除前调用：记 before，discard 时恢复 */
  async recordDelete(path: string, before: string | Uint8Array): Promise<void> {
    if (this.sealed) {
      throw new Error('turn file undo log already sealed');
    }
    const key = pathKey(path);
    const bytes = toBytes(before);
    const existing = this.entriesByPath.get(key);
    if (existing) {
      // first before 不覆盖；但必须记下「工具删了」以便 discard 恢复
      existing.agentDeleted = true;
      existing.afterHash = '';
      existing.afterRef = undefined;
      await this.flushLog();
      return;
    }
    const beforeRef = await this.storeBlob(bytes);
    if (beforeRef === undefined) {
      this.limitHit = true;
      return;
    }
    this.seq += 1;
    this.entriesByPath.set(key, {
      op: 'delete',
      path,
      beforeRef,
      afterHash: '',
      agentDeleted: true,
      seq: this.seq,
    });
    await this.flushLog();
  }

  /** 标记新建（零 before）；已存在条目则不覆盖 first before */
  async recordCreate(path: string, after?: string | Uint8Array): Promise<void> {
    if (this.sealed) {
      throw new Error('turn file undo log already sealed');
    }
    const key = pathKey(path);
    if (!this.entriesByPath.has(key)) {
      this.seq += 1;
      this.entriesByPath.set(key, { op: 'create', path, afterHash: '', agentDeleted: false, seq: this.seq });
    }
    const entry = this.entriesByPath.get(key)!;
    entry.agentDeleted = false;
    if (after !== undefined) {
      const afterBytes = toBytes(after);
      entry.afterHash = sha256Hex(afterBytes);
      if (isProbablyText(afterBytes)) {
        entry.afterRef = await this.storeBlob(afterBytes);
      }
    }
    await this.flushLog();
  }

  /** rename：delete(from) + create/overwrite(to) */
  async recordRename(from: string, to: string): Promise<void> {
    const moved = await readFile(from).catch(() => undefined);
    if (moved) {
      await this.recordDelete(from, moved);
    }
    const priorTo = await readFile(to).catch(() => undefined);
    if (priorTo) {
      // to 已有内容：记 overwrite，discard 须恢复 to 的旧字节
      await this.recordOverwrite(to, priorTo, moved);
    } else {
      await this.recordCreate(to, moved);
    }
  }

  /** 显式 before/after 覆盖（shell diff；磁盘已是 after 时不能用 writeFile 采 before） */
  async noteNotReversed(payload: {
    reason: 'inventory_only' | 'budget_truncated' | 'no_roots' | 'shell_journal_off';
    created?: string[];
    modified?: string[];
    deleted?: string[];
  }): Promise<void> {
    await mkdir(this.paths.root, { recursive: true });
    await writeFile(
      join(this.paths.root, 'not-reversed.json'),
      JSON.stringify(payload) + '\n',
      'utf8',
    );
  }

  async recordOverwrite(
    path: string,
    before: string | Uint8Array,
    after?: string | Uint8Array,
  ): Promise<void> {
    if (this.sealed) {
      throw new Error('turn file undo log already sealed');
    }
    const key = pathKey(path);
    const beforeBytes = toBytes(before);
    if (!this.entriesByPath.has(key)) {
      const beforeRef = await this.storeBlob(beforeBytes);
      if (beforeRef === undefined) {
        this.limitHit = true;
      } else {
        this.seq += 1;
        this.entriesByPath.set(key, {
          op: 'overwrite',
          path,
          beforeRef,
          afterHash: '',
          agentDeleted: false,
          seq: this.seq,
        });
      }
    }
    const entry = this.entriesByPath.get(key);
    if (entry) {
      entry.agentDeleted = false;
      const afterBytes = after !== undefined ? toBytes(after) : await readFile(path).catch(() => undefined);
      if (afterBytes) {
        entry.afterHash = sha256Hex(afterBytes);
        if (isProbablyText(afterBytes)) {
          entry.afterRef = await this.storeBlob(afterBytes);
        }
      }
    }
    await this.flushLog();
  }

  private async recordWrite(
    path: string,
    data: string | Uint8Array,
    mode: 'overwrite' | 'append',
  ): Promise<void> {
    if (this.sealed) {
      throw new Error('turn file undo log already sealed');
    }
    const key = pathKey(path);
    const next = toBytes(data);
    const existing = await readFile(path).catch(() => undefined);

    if (!this.entriesByPath.has(key)) {
      if (
        this.limit?.maxEntries !== undefined &&
        this.limit.maxEntries > 0 &&
        this.entriesByPath.size >= this.limit.maxEntries
      ) {
        this.limitHit = true;
        await this.persistTruncated();
      } else if (existing) {
        const beforeRef = await this.storeBlob(existing);
        if (beforeRef === undefined) {
          // 配额截断：业务仍写，不记 before（不可完整回滚）
          this.limitHit = true;
        } else {
          this.seq += 1;
          this.entriesByPath.set(key, {
            op: 'overwrite',
            path,
            beforeRef,
            afterHash: '',
            agentDeleted: false,
            seq: this.seq,
          });
        }
      } else {
        this.seq += 1;
        this.entriesByPath.set(key, { op: 'create', path, afterHash: '', agentDeleted: false, seq: this.seq });
      }
    }

    const afterBytes = mode === 'append'
      ? existing
        ? Buffer.concat([existing, next])
        : next
      : next;

    const entry = this.entriesByPath.get(key);
    if (entry) {
      entry.agentDeleted = false;
      entry.afterHash = sha256Hex(afterBytes);
      // 文本 after 存一份，供 3WM；二进制只留 hash
      if (isProbablyText(afterBytes)) {
        entry.afterRef = await this.storeBlob(afterBytes);
      }
    }

    if (mode === 'append') {
      await fsAppendFile(path, next);
    } else {
      await writeFile(path, next);
    }
    await this.flushLog();
  }

  /** @returns blob hash；超配额时 undefined（调用方标 truncated） */
  private async storeBlob(data: Buffer): Promise<string | undefined> {
    const hash = sha256Hex(data);
    const blobPath = join(this.paths.blobsDir, hash);
    if (await pathExists(blobPath)) return hash;
    if (this.limit?.maxBlobBytes !== undefined && this.limit.maxBlobBytes > 0) {
      if (this.blobBytes + data.length > this.limit.maxBlobBytes) {
        this.limitHit = true;
        await this.persistTruncated();
        return undefined;
      }
    }
    await writeFile(blobPath, data);
    this.blobBytes += data.length;
    return hash;
  }

  /** limitHit 持久化，供 gateway/close 异进程 discard 读回 */
  private async persistTruncated(): Promise<void> {
    try {
      await mkdir(this.paths.root, { recursive: true });
      await writeFile(
        join(this.paths.root, 'meta.json'),
        JSON.stringify({ truncated: true }) + '\n',
        'utf8',
      );
    } catch {
      // 元数据失败不阻断业务写
    }
  }

  private flushLog(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.doFlushLog()).catch(() => undefined);
    return this.flushChain;
  }

  private async doFlushLog(): Promise<void> {
    const lines: FileUndoEntry[] = [...this.entriesByPath.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((e): FileUndoEntry => {
        if (e.op === 'create') {
          return { op: 'create', path: e.path, afterHash: e.afterHash, afterRef: e.afterRef };
        }
        if (e.op === 'delete' && e.agentDeleted !== false && !e.afterHash) {
          return { op: 'delete', path: e.path, beforeRef: e.beforeRef!, agentDeleted: true };
        }
        // delete 后又有写入：落成 overwrite + agentDeleted，避免异进程丢 after 状态
        return {
          op: 'overwrite',
          path: e.path,
          beforeRef: e.beforeRef!,
          afterHash: e.afterHash,
          afterRef: e.afterRef,
          agentDeleted: e.agentDeleted,
        };
      });
    await mkdir(this.paths.root, { recursive: true });
    const body = lines.map((l) => JSON.stringify(l)).join('\n');
    await writeFile(this.paths.logPath, body + (lines.length ? '\n' : ''), 'utf8');
  }

  /** 提交：丢弃 undo，效应保留 */
  async commit(): Promise<void> {
    this.sealed = true;
    await rm(this.paths.root, { recursive: true, force: true });
  }

  /** 逆放并销毁（编辑重发） */
  async discard(memoryRestorer?: MemoryEffectRestorer): Promise<DiscardFileEffectsResult> {
    this.sealed = true;
    this.memoryJournal.seal();
    return discardFromDir(this.paths, memoryRestorer, this.limitHit);
  }
}

/**
 * 未配置 sessionsDir 时的 fail-closed 写入口：拒绝落盘，禁止静默绕过 undo。
 */
export function createUnconfiguredFileEffects(): ToolFileEffects {
  const fail = async (): Promise<never> => {
    throw new Error(
      'file_effects_not_configured: set SessionAwareRunnerConfig.sessionsDir to enable journaled file writes',
    );
  };
  return {
    writeFile: fail,
    appendFile: fail,
    recordDelete: fail,
    recordCreate: fail,
    recordRename: fail,
    recordOverwrite: fail,
    noteNotReversed: fail,
  };
}

/**
 * 未配置 sessionsDir 时的记忆面 fail-closed 写入口。
 */
export function createUnconfiguredMemoryEffects(): MemoryEffectJournal {
  const fail = async (): Promise<never> => {
    throw new Error(
      'memory_effects_not_configured: set SessionAwareRunnerConfig.sessionsDir to enable journaled memory writes',
    );
  };
  return { recordInsert: fail, recordUpdate: fail, recordDelete: fail };
}

/**
 * 提交某会话残留 undo（继续对话 / turn 自然结束）
 *
 * @param sessionsDir - sessions 目录
 * @param sessionId - 会话 id
 */
export async function commitSessionFileUndo(sessionsDir: string, sessionId: string): Promise<void> {
  const { root } = resolveSessionUndoPaths(sessionsDir, sessionId);
  await rm(root, { recursive: true, force: true });
}

/**
 * 逆放某会话本轮文件效应（编辑重发）
 *
 * @param sessionsDir - sessions 目录
 * @param sessionId - 会话 id
 * @returns 逆放结果（宿主可见，不进 LLM 历史）
 */
export async function discardSessionFileUndo(
  sessionsDir: string,
  sessionId: string,
  memoryRestorer?: MemoryEffectRestorer,
): Promise<DiscardFileEffectsResult> {
  return discardFromDir(resolveSessionUndoPaths(sessionsDir, sessionId), memoryRestorer, false);
}

async function discardFromDir(
  paths: SessionUndoPaths,
  memoryRestorer: MemoryEffectRestorer | undefined,
  limitHit: boolean,
): Promise<DiscardFileEffectsResult> {
  const memory = await discardMemoryUndo(paths.root, memoryRestorer);
  const result: DiscardFileEffectsResult = {
    discarded: [],
    keptUserEdits: [],
    entries: 0,
    memory,
  };
  // truncated 持久化在 meta.json（异进程 discard 必读）
  try {
    const metaRaw = await readFile(join(paths.root, 'meta.json'), 'utf8');
    const meta = JSON.parse(metaRaw) as { truncated?: boolean };
    if (meta.truncated) result.truncated = true;
  } catch {
    // 无 meta
  }
  if (limitHit) result.truncated = true;
  // shell 等不可逆清单（§5.6：不进 log.jsonl）
  try {
    const nrPath = join(paths.root, 'not-reversed.json');
    const nrRaw = await readFile(nrPath, 'utf8');
    result.notReversed = JSON.parse(nrRaw) as NotReversedEffects;
  } catch {
    // 无不可逆记录属正常
  }
  if (!(await pathExists(paths.logPath))) {
    await rm(paths.root, { recursive: true, force: true });
    return result;
  }
  const raw = await readFile(paths.logPath, 'utf8');
  const entries = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FileUndoEntry);
  result.entries = entries.length;

  // 逆序：rename 的 delete+create 对须先处理 to 再处理 from
  for (const entry of [...entries].reverse()) {
    await revertEntry(paths, entry, result);
  }
  await rm(paths.root, { recursive: true, force: true });
  return result;
}

async function revertEntry(
  paths: SessionUndoPaths,
  entry: FileUndoEntry,
  result: DiscardFileEffectsResult,
): Promise<void> {
  const current = await readFile(entry.path).catch(() => undefined);
  const currentHash = current ? sha256Hex(current) : undefined;
  // 以**最后**工具效应为准：delete 条目在后续 write 后 agentDeleted=false
  const agentDeleted =
    entry.op === 'delete'
      ? entry.agentDeleted !== false
      : entry.op === 'overwrite' && entry.agentDeleted === true;

  // 本轮新建：discard = 删除（用户改动则保留）
  if (entry.op === 'create' && !('beforeRef' in entry && entry.beforeRef)) {
    if (!current) return;
    if (currentHash !== entry.afterHash) {
      result.keptUserEdits.push({ path: entry.path, reason: 'user_recreated' });
      return;
    }
    await rm(entry.path, { force: true });
    result.discarded.push({ path: entry.path, action: 'deleted' });
    return;
  }

  const beforeRef = entry.op === 'create' ? undefined : entry.beforeRef;
  if (!beforeRef) return;
  const before = await readFile(join(paths.blobsDir, beforeRef));
  const beforeHash = sha256Hex(before);

  if (!current) {
    if (agentDeleted) {
      // 工具删除 → 恢复 before
      await writeFile(entry.path, before);
      result.discarded.push({ path: entry.path, action: 'restored' });
      return;
    }
    // 用户在工具改写后删了文件：尊重用户
    result.keptUserEdits.push({ path: entry.path, reason: 'user_deleted' });
    return;
  }

  if (currentHash === beforeHash) return;

  if (agentDeleted) {
    // 工具删后文件又存在：用户重建则保留；与工具 after 一致则恢复
    const afterHash = entry.op === 'overwrite' ? entry.afterHash : undefined;
    if (afterHash && currentHash === afterHash) {
      await writeFile(entry.path, before);
      result.discarded.push({ path: entry.path, action: 'restored' });
      return;
    }
    result.keptUserEdits.push({ path: entry.path, reason: 'user_recreated' });
    return;
  }

  const entryAfterHash = entry.op === 'overwrite' || entry.op === 'create' ? entry.afterHash : '';
  if (entryAfterHash && currentHash === entryAfterHash) {
    await writeFile(entry.path, before);
    result.discarded.push({ path: entry.path, action: 'restored' });
    return;
  }

  const afterRef = entry.op === 'create' ? entry.afterRef : entry.op === 'overwrite' ? entry.afterRef : undefined;
  const afterHash = entry.op === 'create' ? entry.afterHash : entry.op === 'overwrite' ? entry.afterHash : '';
  void afterHash;
  const textOk = isProbablyText(before) && isProbablyText(current);
  if (textOk && afterRef) {
    const after = await readFile(join(paths.blobsDir, afterRef), 'utf8');
    const rev = reverseAgentOverwrite(before.toString('utf8'), after, current.toString('utf8'));
    if (rev.kind === 'restored') {
      await writeFile(entry.path, rev.content, 'utf8');
      result.discarded.push({ path: entry.path, action: 'restored' });
      if (rev.skippedHunks > 0) {
        result.keptUserEdits.push({ path: entry.path, reason: 'merge_conflict' });
      }
      return;
    }
    result.keptUserEdits.push({ path: entry.path, reason: 'merge_conflict' });
    return;
  }

  result.keptUserEdits.push({ path: entry.path, reason: 'binary_user_wins' });
}

/**
 * 会话关闭/删除时处理残留 undo（commit=manual 才有意义；auto 下 turn 已 commit）。
 *
 * @param options - sessionsDir + sessionId + onClose 策略
 * @returns 实际动作
 */
export async function resolveSessionUndoOnClose(options: {
  sessionsDir: string;
  sessionId: string;
  onClose: 'commit' | 'discard';
  memoryRestorer?: import('./memory-undo.js').MemoryEffectRestorer;
}): Promise<'committed' | 'discarded' | 'none'> {
  const paths = resolveSessionUndoPaths(options.sessionsDir, options.sessionId);
  if (!(await pathExists(paths.root))) return 'none';
  if (options.onClose === 'discard') {
    await discardSessionFileUndo(options.sessionsDir, options.sessionId, options.memoryRestorer);
    return 'discarded';
  }
  await commitSessionFileUndo(options.sessionsDir, options.sessionId);
  return 'committed';
}

/** 孤儿 undo 目录（崩溃/异常退出残留） */
export interface OrphanUndoDir {
  sessionDirName: string;
  undoRoot: string;
  entries: number;
  hasMemory: boolean;
  hasNotReversed: boolean;
}

/**
 * 扫描会话 undo 孤儿目录（doctor 兜底）。
 *
 * 正常路径下 commit/discard 会删除 `sessions/<sid>/undo`；仍存在的即残留。
 *
 * @param sessionsDir - `OCTOPI_HOME/sessions`
 * @returns 孤儿列表
 */
export async function scanOrphanSessionUndo(sessionsDir: string): Promise<OrphanUndoDir[]> {
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const out: OrphanUndoDir[] = [];
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    const undoRoot = join(sessionsDir, ent.name, 'undo');
    if (!(await pathExists(undoRoot))) continue;
    let entries = 0;
    try {
      const raw = await readFile(join(undoRoot, 'log.jsonl'), 'utf8');
      entries = raw.split('\n').filter((l) => l.trim()).length;
    } catch {
      entries = 0;
    }
    out.push({
      sessionDirName: ent.name,
      undoRoot,
      entries,
      hasMemory: await pathExists(join(undoRoot, 'memory.jsonl')),
      hasNotReversed: await pathExists(join(undoRoot, 'not-reversed.json')),
    });
  }
  return out;
}