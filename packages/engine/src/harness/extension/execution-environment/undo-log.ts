/**
 * Turn 文件 undo（ToolEffectPolicy L3）
 *
 * 即时生效 + 本轮 undo log：工具写立刻落盘，同时记录写前字节。
 * 「编辑重发」discard 只逆放 agent 工具效应；用户手改保留。
 * 落盘：`sessions/<sid>/undo/`（与 attachments 同级，不进 agent home / workspace）。
 *
 * 见 arch/tool-effect-policy.md。
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
    };

export type DiscardConflictReason =
  | 'merge_conflict'
  | 'binary_user_wins'
  | 'user_deleted'
  | 'user_recreated';

/** 编辑重发文件效应逆放结果（宿主可见；不进 LLM 历史） */
export interface DiscardFileEffectsResult {
  discarded: Array<{ path: string; action: 'deleted' | 'restored' }>;
  keptUserEdits: Array<{ path: string; reason: DiscardConflictReason }>;
  entries: number;
  /** 记忆面逆放（P2） */
  memory: DiscardMemoryEffectsResult;
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
  op: 'create' | 'overwrite';
  path: string;
  beforeRef?: string;
  afterHash: string;
  afterRef?: string;
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
  /** 记忆面 journal（P2）；与文件共用 undo 根 */
  readonly memoryJournal: TurnMemoryJournal;

  private constructor(paths: SessionUndoPaths) {
    this.paths = paths;
    this.memoryJournal = new TurnMemoryJournal(paths.root);
  }

  /** ToolExecutionContext.memoryEffects */
  get memoryEffects(): MemoryEffectJournal {
    return this.memoryJournal;
  }

  /**
   * 开始本轮 undo。若已有残留 log（上一轮中止后继续对话），先 commit。
   *
   * @param options - sessionsDir + sessionId
   * @returns 日志实例
   */
  static async begin(options: { sessionsDir: string; sessionId: string }): Promise<TurnFileUndoLog> {
    const paths = resolveSessionUndoPaths(options.sessionsDir, options.sessionId);
    if (await pathExists(paths.root)) {
      await rm(paths.root, { recursive: true, force: true });
    }
    await mkdir(paths.blobsDir, { recursive: true });
    const log = new TurnFileUndoLog(paths);
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
      if (existing) {
        const beforeRef = await this.storeBlob(existing);
        this.seq += 1;
        this.entriesByPath.set(key, {
          op: 'overwrite',
          path,
          beforeRef,
          afterHash: '',
          seq: this.seq,
        });
      } else {
        this.seq += 1;
        this.entriesByPath.set(key, { op: 'create', path, afterHash: '', seq: this.seq });
      }
    }

    const afterBytes = mode === 'append'
      ? existing
        ? Buffer.concat([existing, next])
        : next
      : next;

    const entry = this.entriesByPath.get(key)!;
    entry.afterHash = sha256Hex(afterBytes);
    // 文本 after 存一份，供 3WM；二进制只留 hash
    if (isProbablyText(afterBytes)) {
      entry.afterRef = await this.storeBlob(afterBytes);
    }

    if (mode === 'append') {
      await fsAppendFile(path, next);
    } else {
      await writeFile(path, next);
    }
    await this.flushLog();
  }

  private async storeBlob(data: Buffer): Promise<string> {
    const hash = sha256Hex(data);
    const blobPath = join(this.paths.blobsDir, hash);
    if (!(await pathExists(blobPath))) {
      await writeFile(blobPath, data);
    }
    return hash;
  }

  private flushLog(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.doFlushLog()).catch(() => undefined);
    return this.flushChain;
  }

  private async doFlushLog(): Promise<void> {
    const lines: FileUndoEntry[] = [...this.entriesByPath.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((e) =>
        e.op === 'create'
          ? { op: 'create', path: e.path, afterHash: e.afterHash, afterRef: e.afterRef }
          : {
              op: 'overwrite',
              path: e.path,
              beforeRef: e.beforeRef!,
              afterHash: e.afterHash,
              afterRef: e.afterRef,
            },
      );
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
    return discardFromDir(this.paths, memoryRestorer);
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
  return { writeFile: fail, appendFile: fail };
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
  return discardFromDir(resolveSessionUndoPaths(sessionsDir, sessionId), memoryRestorer);
}

async function discardFromDir(
  paths: SessionUndoPaths,
  memoryRestorer?: MemoryEffectRestorer,
): Promise<DiscardFileEffectsResult> {
  const memory = await discardMemoryUndo(paths.root, memoryRestorer);
  const result: DiscardFileEffectsResult = {
    discarded: [],
    keptUserEdits: [],
    entries: 0,
    memory,
  };
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

  for (const entry of entries) {
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

  if (entry.op === 'create') {
    if (!current) return;
    if (currentHash !== entry.afterHash) {
      result.keptUserEdits.push({ path: entry.path, reason: 'user_recreated' });
      return;
    }
    await rm(entry.path, { force: true });
    result.discarded.push({ path: entry.path, action: 'deleted' });
    return;
  }

  if (!current) {
    result.keptUserEdits.push({ path: entry.path, reason: 'user_deleted' });
    return;
  }

  const before = await readFile(join(paths.blobsDir, entry.beforeRef));
  const beforeHash = sha256Hex(before);
  if (currentHash === beforeHash) return;
  if (currentHash === entry.afterHash) {
    await writeFile(entry.path, before);
    result.discarded.push({ path: entry.path, action: 'restored' });
    return;
  }

  const textOk = isProbablyText(before) && isProbablyText(current);
  if (textOk && entry.afterRef) {
    const after = await readFile(join(paths.blobsDir, entry.afterRef), 'utf8');
    const rev = reverseAgentOverwrite(before.toString('utf8'), after, current.toString('utf8'));
    if (rev.kind === 'restored') {
      await writeFile(entry.path, rev.content, 'utf8');
      result.discarded.push({ path: entry.path, action: 'restored' });
      if (rev.skippedHunks > 0) {
        // 用户改过的 hunk 未逆放，内容已保留——供宿主知晓
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
