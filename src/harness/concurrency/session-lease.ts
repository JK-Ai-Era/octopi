/**
 * Session Lease interface (constitution E2 / E7).
 *
 * Lock authority key = sessionId. v1 ships in-process FIFO lock only.
 * Distributed deployments MUST implement SessionLease; do not pretend
 * in-memory locks are globally valid.
 */

/**
 * Session lease / lock port
 */
export interface SessionLease {
  /**
   * Acquire exclusive lease for a session.
   *
   * @param sessionId - lease key (E2)
   * @returns release function (idempotent)
   */
  acquire(sessionId: string): Promise<() => void>;

  /**
   * Whether the session lease is currently held in this process.
   *
   * @param sessionId - lease key
   * @returns true if held locally
   */
  isHeld(sessionId: string): boolean;
}

interface QueueEntry {
  resolve: () => void;
}

/**
 * In-process session lock (v1 default).
 *
 * FIFO queue per sessionId; same process only (E7 single-process assumption).
 */
export class InProcessSessionLock implements SessionLease {
  private locked = new Map<string, boolean>();
  private queues = new Map<string, QueueEntry[]>();

  /**
   * Acquire session lease
   *
   * @param sessionId - lease key
   * @returns release function
   */
  async acquire(sessionId: string): Promise<() => void> {
    if (this.locked.get(sessionId)) {
      await new Promise<void>((resolve) => {
        if (!this.queues.has(sessionId)) {
          this.queues.set(sessionId, []);
        }
        this.queues.get(sessionId)!.push({ resolve });
      });
    }

    this.locked.set(sessionId, true);

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const queue = this.queues.get(sessionId);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        next.resolve();
      } else {
        this.locked.set(sessionId, false);
        this.queues.delete(sessionId);
      }
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
