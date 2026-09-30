/**
 * Session Lease interface (constitution E2 / E7).
 *
 * Lock authority key = sessionId. v1 ships in-process FIFO lock only.
 * Distributed deployments MUST implement SessionLease; do not pretend
 * in-memory locks are globally valid.
 */

/** Options for {@link SessionLease.acquire} */
export interface SessionLeaseAcquireOptions {
  /**
   * Abort while waiting in the queue. Already-held leases are unaffected;
   * the caller still owns release once acquire resolves.
   */
  signal?: AbortSignal;
}

/**
 * Session lease / lock port
 */
export interface SessionLease {
  /**
   * Acquire exclusive lease for a session.
   *
   * @param sessionId - lease key (E2)
   * @param options - optional abort while queued
   * @returns release function (idempotent)
   * @throws when aborted while waiting (never resolves with a release fn)
   */
  acquire(sessionId: string, options?: SessionLeaseAcquireOptions): Promise<() => void>;

  /**
   * Whether the session lease is currently held in this process.
   *
   * @param sessionId - lease key
   * @returns true if held locally
   */
  isHeld(sessionId: string): boolean;
}

interface QueueEntry {
  /** Hand the lease to this waiter; returns false if already settled */
  settleGrant: () => boolean;
  /** Fail this waiter; returns false if already settled */
  settleAbort: (err: Error) => boolean;
}

/**
 * In-process session lock (v1 default).
 *
 * FIFO queue per sessionId; same process only (E7 single-process assumption).
 * Waiting acquires honor AbortSignal so a queued run can be cancelled without
 * waiting for the current holder to finish.
 */
export class InProcessSessionLock implements SessionLease {
  private locked = new Map<string, boolean>();
  private queues = new Map<string, QueueEntry[]>();

  /**
   * Acquire session lease
   *
   * @param sessionId - lease key
   * @param options - optional abort while queued
   * @returns release function
   */
  async acquire(sessionId: string, options?: SessionLeaseAcquireOptions): Promise<() => void> {
    const signal = options?.signal;
    if (signal?.aborted) {
      throw new Error('Session lease acquire aborted');
    }

    if (this.locked.get(sessionId)) {
      await new Promise<void>((resolve, reject) => {
        let queue = this.queues.get(sessionId);
        if (!queue) {
          queue = [];
          this.queues.set(sessionId, queue);
        }

        let settled = false;
        const cleanup = () => {
          signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          entry.settleAbort(new Error('Session lease acquire aborted'));
        };
        const entry: QueueEntry = {
          settleGrant: () => {
            if (settled) return false;
            settled = true;
            cleanup();
            resolve();
            return true;
          },
          settleAbort: (err) => {
            if (settled) return false;
            settled = true;
            cleanup();
            const q = this.queues.get(sessionId);
            if (q) {
              const idx = q.indexOf(entry);
              if (idx >= 0) q.splice(idx, 1);
            }
            reject(err);
            return true;
          },
        };

        signal?.addEventListener('abort', onAbort, { once: true });
        queue.push(entry);
      });
    }

    this.locked.set(sessionId, true);

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const queue = this.queues.get(sessionId);
      if (queue && queue.length > 0) {
        // Hand off to the next live waiter; skip any already-settled leftovers.
        while (queue.length > 0) {
          const next = queue.shift()!;
          if (next.settleGrant()) return;
        }
      }
      this.locked.set(sessionId, false);
      this.queues.delete(sessionId);
    };
  }

  /**
   * Local hold check
   *
   * @param sessionId - lease key
   * @returns true if locked in this process
   */
  isHeld(sessionId: string): boolean {
    return this.locked.get(sessionId) === true;
  }
}

/**
 * Placeholder for distributed Session Lease (E7 reserved).
 *
 * Cross-process deployments must replace InProcessSessionLock with a real
 * lease backend (e.g. Redis/DB). This stub documents the contract only.
 */
export interface DistributedSessionLease extends SessionLease {
  /** Backend identifier for diagnostics */
  readonly backend: string;
  /**
   * Optional TTL heartbeat; distributed backends renew leases.
   *
   * @param sessionId - lease key
   * @returns true if renewal succeeded
   */
  renew?(sessionId: string): Promise<boolean>;
}
