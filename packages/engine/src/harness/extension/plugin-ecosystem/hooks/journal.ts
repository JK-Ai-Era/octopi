import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HookAuditRecord } from './types.js';

/** Append-only hook audit; not a tamper-evident ledger or a sandbox. */
export class HookAuditJournal {
  private tail = Promise.resolve();

  constructor(private readonly rootDir: () => string) {}

  /** Serialize appends per journal instance and surface write failures to the Host. */
  append(record: HookAuditRecord): Promise<void> {
    const task = this.tail.then(async () => {
      const directory = join(this.rootDir(), 'hooks');
      await mkdir(directory, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      const entry = { timestamp: Date.now(), ...record };
      await appendFile(join(directory, `${day}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
}
