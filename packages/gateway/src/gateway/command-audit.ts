/** Persistent authorization decisions for Commands; separate from Discourse. */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrincipalRef } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/commands/types.js';

export interface CommandDeniedAuditEvent {
  type: 'command_denied';
  at: number;
  sessionId: string;
  agentId: string;
  command: string;
  source: 'plugin';
  pluginId: string;
  principal: PrincipalRef;
  requestedOps: string[];
  deniedOps: string[];
  reason: 'unregistered_contribution' | 'undeclared_session_ops';
}

/** Append-only daily Command authorization audit; it is not a tamper-evident ledger. */
export class CommandAuditJournal {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly auditDir: () => string) {}

  /**
   * Persist a denial before reporting the command result.
   *
   * @param event - Host-derived identities and requested/authorized operation names
   * @returns Resolves after this process's prior audit write and this append finish
   */
  async appendDenied(event: CommandDeniedAuditEvent): Promise<void> {
    const day = new Date(event.at).toISOString().slice(0, 10);
    const dir = join(this.auditDir(), 'commands');
    await mkdir(dir, { recursive: true });
    const next = this.writeTail.then(async () => {
      await appendFile(join(dir, `${day}.jsonl`), `${JSON.stringify(event)}\n`, 'utf8');
    });
    this.writeTail = next.catch(() => {});
    await next;
  }
}
