/**
 * Turn 记忆面 undo（ToolEffectPolicy L3 P2）
 *
 * 与文件 undo 同目录（`sessions/<sid>/undo/memory.jsonl`）。
 * 只覆盖 **本轮 run 作用域内** 经 store 写口的效应；steward 异步写不进 journal。
 * knowledge 不在此列（非事务）。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  MemoryEffectDomain,
  MemoryEffectJournal,
} from '@octopi-agent/core/types/tools.js';
import type { MemoryEntry, MemoryStore } from '../../memory/types.js';

/** 记忆面 undo 条目 */
export type MemoryUndoEntry =
  | { op: 'insert'; domain: MemoryEffectDomain; id: string }
  | { op: 'update'; domain: MemoryEffectDomain; id: string; before: unknown }
  | { op: 'delete'; domain: MemoryEffectDomain; id: string; before: unknown };

/** 记忆面逆放执行器（由 store 提供） */
export interface MemoryEffectRestorer {
  /** 逆放 insert：按 id 删除 */
  deleteById(domain: MemoryEffectDomain, id: string): Promise<void>;
  /** 逆放 update/delete：恢复 before 整行（同 id） */
  restoreRow(domain: MemoryEffectDomain, id: string, before: unknown): Promise<void>;
}

export interface DiscardMemoryEffectsResult {
  reversed: Array<{ domain: MemoryEffectDomain; id: string; op: MemoryUndoEntry['op'] }>;
  failed: Array<{ domain: MemoryEffectDomain; id: string; reason: string }>;
  entries: number;
}

function memoryLogPath(undoRoot: string): string {
  return join(undoRoot, 'memory.jsonl');
}

/** 本轮记忆 journal 写入端 */
export class TurnMemoryJournal implements MemoryEffectJournal {
  private readonly entries: MemoryUndoEntry[] = [];
  private sealed = false;
  private readonly logPath: string;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(undoRoot: string) {
    this.logPath = memoryLogPath(undoRoot);
  }

  get size(): number {
    return this.entries.length;
  }

  async recordInsert(domain: MemoryEffectDomain, id: string): Promise<void> {
    this.append({ op: 'insert', domain, id });
    await this.flush();
  }

  async recordUpdate(domain: MemoryEffectDomain, id: string, before: unknown): Promise<void> {
    this.append({ op: 'update', domain, id, before });
    await this.flush();
  }

  async recordDelete(domain: MemoryEffectDomain, id: string, before: unknown): Promise<void> {
    this.append({ op: 'delete', domain, id, before });
    await this.flush();
  }

  private append(entry: MemoryUndoEntry): void {
    if (this.sealed) {
      throw new Error('turn memory undo journal already sealed');
    }
    this.entries.push(entry);
  }

  private flush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.doFlush()).catch(() => undefined);
    return this.flushChain;
  }

  private async doFlush(): Promise<void> {
    await mkdir(join(this.logPath, '..'), { recursive: true });
    const body = this.entries.map((e) => JSON.stringify(e)).join('\n');
    await writeFile(this.logPath, body + (this.entries.length ? '\n' : ''), 'utf8');
  }

  seal(): void {
    this.sealed = true;
  }
}

/**
 * 逆放记忆效应（编辑重发）。按记录逆序执行。
 *
 * @param undoRoot - `sessions/<sid>/undo`
 * @param restorer - store 逆放器；缺失时全部记 failed
 * @returns 逆放结果
 */
export async function discardMemoryUndo(
  undoRoot: string,
  restorer?: MemoryEffectRestorer,
): Promise<DiscardMemoryEffectsResult> {
  const result: DiscardMemoryEffectsResult = { reversed: [], failed: [], entries: 0 };
  const path = memoryLogPath(undoRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return result;
  }
  const entries = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as MemoryUndoEntry);
  result.entries = entries.length;

  for (const entry of [...entries].reverse()) {
    if (!restorer) {
      result.failed.push({ domain: entry.domain, id: entry.id, reason: 'memory_restorer_missing' });
      continue;
    }
    try {
      if (entry.op === 'insert') {
        await restorer.deleteById(entry.domain, entry.id);
      } else {
        await restorer.restoreRow(entry.domain, entry.id, entry.before);
      }
      result.reversed.push({ domain: entry.domain, id: entry.id, op: entry.op });
    } catch (err) {
      result.failed.push({
        domain: entry.domain,
        id: entry.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await rm(path, { force: true });
  return result;
}

/**
 * MemoryStore 装饰器：写口记 journal（RunScope ALS 提供）。
 * 无活跃 journal 时写入照常（steward / turn 外），不记 undo。
 */
export class JournaledMemoryStore implements MemoryStore {
  readonly name: string;

  constructor(
    private readonly inner: MemoryStore,
    private readonly journalSource: () => MemoryEffectJournal | undefined,
  ) {
    this.name = inner.name;
  }

  async store(
    entry: Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'decayFactor'>,
  ): Promise<string> {
    const id = await this.inner.store(entry);
    await this.journalSource()?.recordInsert('memory', id);
    return id;
  }

  retrieve: MemoryStore['retrieve'] = (query) => this.inner.retrieve(query);

  get(id: string): Promise<MemoryEntry | null> {
    return this.inner.get(id);
  }

  async update(id: string, patch: Partial<MemoryEntry>): Promise<void> {
    const before = await this.inner.get(id);
    await this.inner.update(id, patch);
    if (before) await this.journalSource()?.recordUpdate('memory', id, before);
  }

  async delete(id: string): Promise<void> {
    const before = await this.inner.get(id);
    await this.inner.delete(id);
    if (before) await this.journalSource()?.recordDelete('memory', id, before);
  }

  async softDelete(
    id: string,
    meta: { by: string; reason: string; winnerId?: string },
  ): Promise<void> {
    const before = await this.inner.get(id);
    await this.inner.softDelete(id, meta);
    if (before) await this.journalSource()?.recordUpdate('memory', id, before);
  }

  async undelete(id: string): Promise<void> {
    const before = await this.inner.get(id);
    await this.inner.undelete(id);
    if (before) await this.journalSource()?.recordUpdate('memory', id, before);
  }

  async importEntry(entry: MemoryEntry): Promise<void> {
    const withImport = this.inner as MemoryStore & {
      importEntry?(entry: MemoryEntry): Promise<void>;
    };
    if (withImport.importEntry) {
      await withImport.importEntry(entry);
      await this.journalSource()?.recordInsert('memory', entry.id);
      return;
    }
    throw new Error('importEntry_not_supported');
  }

  listForGovern: MemoryStore['listForGovern'] = (filter) => this.inner.listForGovern(filter);
  decay: MemoryStore['decay'] = (options) => this.inner.decay(options);
  stats: MemoryStore['stats'] = () => this.inner.stats();
}

/**
 * 由 MemoryStore 实现 restorer（编辑重发逆放）。
 *
 * @param store - 记忆 store
 * @returns restorer
 */
export function createMemoryRestorer(store: MemoryStore): MemoryEffectRestorer {
  return {
    async deleteById(_domain, id) {
      await store.delete(id);
    },
    async restoreRow(_domain, id, before) {
      const row = before as Partial<MemoryEntry> & { id?: string };
      const existing = await store.get(id);
      if (existing) {
        await store.update(id, row);
        // softDelete 痕迹：before 未删而 current 已删 → undelete
        if (!row.deleted && existing.deleted) {
          await store.undelete(id);
        }
        return;
      }
      const withImport = store as MemoryStore & {
        importEntry?(entry: MemoryEntry): Promise<void>;
      };
      if (withImport.importEntry) {
        await withImport.importEntry({ ...(row as MemoryEntry), id });
        return;
      }
      throw new Error(`cannot_restore_memory_row:${id}`);
    },
  };
}
