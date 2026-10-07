/**
 * knowledge.db writer lock — sole writer process (Knowledge Service child)
 *
 * The lock MUST be held by the process that opens knowledge.db, not by Gateway.
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export interface WriterLockHolder {
  lockPath: string;
  /** 释放锁文件（仅仍属本 PID 时） */
  release(): void;
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 独占创建 writer.lock；持有者死亡则回收。
 *
 * @param dbPath - knowledge.db 绝对路径
 * @returns lock 路径与 release
 * @throws 已有存活持有者时抛错
 */
export async function acquireKnowledgeWriterLock(dbPath: string): Promise<WriterLockHolder> {
  const lockPath = `${dbPath}.writer.lock`;
  const tryWrite = (): void => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, at: Date.now() }),
      { encoding: 'utf8', flag: 'wx' },
    );
  };
  try {
    tryWrite();
  } catch {
    let holderPid: number | undefined;
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number };
      holderPid = lock.pid;
    } catch {
      holderPid = undefined;
    }
    const holderAlive =
      holderPid != null && holderPid !== process.pid && (await isPidAlive(holderPid));
    if (holderAlive) {
      throw new Error(
        `knowledge.db already locked by PID ${holderPid} (${lockPath}); stop the other Knowledge Service or use remote baseUrl`,
      );
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    tryWrite();
  }
  return {
    lockPath,
    release(): void {
      try {
        const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number };
        if (lock.pid !== process.pid) return;
      } catch {
        return;
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    },
  };
}
