/**
 * FileWatchSource — 文件变更 → Trigger（Integration）
 *
 * 使用 fs.watch；适合嵌入方目录监听。emit 非阻塞。
 */

import { watch, type FSWatcher } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Trigger, TriggerSource } from '../../harness/agent-runtime/types.js';

export interface FileWatchSourceConfig {
  id?: string;
  /** 监听目录 */
  dir: string;
  agentId: string;
  sessionId?: string;
  /** 文件名过滤（后缀） */
  extensions?: string[];
  /** 变更说明模板；{{file}} 替换为路径 */
  noteTemplate?: string;
  /** 同文件防抖窗口 ms（默认 200） */
  debounceMs?: number;
}

export class FileWatchSource implements TriggerSource {
  readonly id: string;
  readonly type = 'event' as const;
  private watcher?: FSWatcher;
  private running = false;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly config: FileWatchSourceConfig) {
    this.id = config.id ?? `filewatch-${randomUUID().slice(0, 8)}`;
  }

  async start(emit: (t: Trigger) => void): Promise<void> {
    if (this.running) return;
    const { dir, extensions } = this.config;
    const debounceMs = this.config.debounceMs ?? 200;
    this.watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (!this.running || !filename) return;
      const name = filename.toString();
      if (extensions && extensions.length > 0 && !extensions.some((e) => name.endsWith(e))) {
        return;
      }
      const prev = this.debounceTimers.get(name);
      if (prev) clearTimeout(prev);
      this.debounceTimers.set(
        name,
        setTimeout(() => {
          this.debounceTimers.delete(name);
          if (!this.running) return;
          const template = this.config.noteTemplate ?? 'File changed: {{file}}';
          const content = template.replace('{{file}}', name);
          emit({
            id: `trg-${randomUUID().slice(0, 12)}`,
            type: 'event',
            agentId: this.config.agentId,
            sessionId: this.config.sessionId,
            payload: { kind: 'system_note', content },
            metadata: { source: this.id, reason: 'file_watch' },
          });
        }, debounceMs),
      );
    });
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    this.watcher?.close();
    this.watcher = undefined;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
