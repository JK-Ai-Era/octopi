/**
 * startKnowledgeServiceProcess — fork 独立子进程托管 Knowledge Service
 *
 * 为什么是进程而不是 Worker：知识索引重且稳定不可控，不得与 Gateway 共命运。
 * Worker 仍共享堆/OOM 与进程生命周期，只是把 event loop 挪开，不是故障隔离。
 *
 * fork 根因约束见 `forkChildNodeOptions`（`execArgv: []` / 剥离 `NODE_CHANNEL_*` /
 * `windowsHide` / Electron 宿主）。本处只保留两点知识专属取舍：
 * - `stdio` 全 `ignore` 而非 `inherit`：Windows 管道句柄继承会干扰 IPC
 *   （run 实例相反——它的日志要靠继承的 fd 落 `logs/gateway.log`）。
 * - **保持** `process.execPath`：Electron 下换成捆绑 node.exe 会切断 Windows 上的 fork IPC。
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkChildNodeOptions } from '../../fork-child.js';
import { resolveWorkerUrl } from '../../worker-path.js';
import type { KnowledgeServiceToken } from './http-app.js';
import type { DocumentCapabilityConfig } from '../capabilities/document/factory.js';
import type { KnowledgeBootEmbed, KnowledgeBootIngest, KnowledgeBootRetriever } from './boot-config.js';

export interface KnowledgeServiceProcessOptions {
  dbPath: string;
  port?: number;
  host?: string;
  tokens: KnowledgeServiceToken[];
  documentConfig?: DocumentCapabilityConfig | null;
  embed?: KnowledgeBootEmbed;
  /** Ingest 调参（knowledge.load / index.queue / index.files） */
  ingest?: KnowledgeBootIngest;
  /** 检索调参（knowledge.keywordWeight / autoInject / hint / index.hybridKeyword） */
  retriever?: KnowledgeBootRetriever;
  /** false = 索引稳定后不自动生成 generatedDescription（knowledge.catalog.autoDescribe） */
  autoDescribe?: boolean;
  sqliteVecExtensionPath?: string;
  embeddingModels?: {
    providers?: Record<string, unknown>;
    embedding?: unknown;
  } | null;
  startTimeoutMs?: number;
}

export interface KnowledgeServiceProcessHandle {
  child: ChildProcess;
  port: number;
  /**
   * 停止子进程并**等待其退出**。connected 时先发 close 让其优雅收摊，3s 未退则
   * SIGTERM，再 2s 未退则 SIGKILL；通道已断（宿主硬死）时直接走信号升级。
   * SIGKILL 之后仍等 1s 观察 exit，超时则放行（避免不可观测的僵尸让调用方永久挂起，
   * 代价是极端情形下进程可能尚未完全退出）。
   */
  stop(): Promise<void>;
}

/**
 * 组装 boot 文件内容 — Gateway 调参面 → Service 子进程的唯一交接面（纯函数，可单测锁 hop）。
 *
 * @param opts - 进程启动选项（与 startKnowledgeService 同构 + embeddingModels）
 * @returns boot JSON 对象（与 knowledge-serve-child 的 BootFile 同构）
 */
export function buildKnowledgeServiceBootFile(
  opts: KnowledgeServiceProcessOptions,
): Record<string, unknown> {
  return {
    dbPath: opts.dbPath,
    host: opts.host,
    port: opts.port ?? 18280,
    tokens: opts.tokens,
    documentConfig: opts.documentConfig ?? null,
    embed: opts.embed,
    ingest: opts.ingest,
    retriever: opts.retriever,
    autoDescribe: opts.autoDescribe,
    sqliteVecExtensionPath: opts.sqliteVecExtensionPath,
    embeddingModels: opts.embeddingModels ?? null,
  };
}

/**
 * 在独立子进程启动 Knowledge HTTP Service。
 *
 * @param opts - 与 startKnowledgeService 同构 + embeddingModels（子进程内重建 provider）
 * @returns child + 端口 + stop
 */
export async function startKnowledgeServiceProcess(
  opts: KnowledgeServiceProcessOptions,
): Promise<KnowledgeServiceProcessHandle> {
  const entry = fileURLToPath(resolveWorkerUrl('./knowledge-serve-child.js', import.meta.url));
  const bootDir = await mkdtemp(join(tmpdir(), 'octopi-kn-boot-'));
  const bootPath = join(bootDir, 'boot.json');
  await writeFile(bootPath, JSON.stringify(buildKnowledgeServiceBootFile(opts)), 'utf8');

  // execPath 保持 process.execPath：Electron 下换捆绑 node 会切断 IPC
  const child = fork(entry, [bootPath], forkChildNodeOptions({
    stdio: ['ignore', 'ignore', 'ignore'],
  }));

  const startTimeoutMs = opts.startTimeoutMs ?? 30_000;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('knowledge_process_start_timeout')),
        startTimeoutMs,
      );
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        child.off('message', onMsg);
        fn();
      };
      const onMsg = (msg: { type?: string; port?: number; error?: string }) => {
        if (msg?.type === 'ready' && typeof msg.port === 'number') {
          const port = msg.port;
          settle(() => resolve(port));
        } else if (msg?.type === 'error') {
          settle(() => reject(new Error(msg.error ?? 'knowledge_process_start_failed')));
        }
      };
      child.on('message', onMsg);
      child.once('error', (err) => {
        settle(() => reject(err));
      });
      child.once('exit', (code, signal) => {
        settle(() =>
          reject(
            new Error(
              signal
                ? `knowledge_process_signal_${signal}`
                : `knowledge_process_exit_${code ?? 'unknown'}`,
            ),
          ),
        );
      });
    });

    return {
      child,
      port,
      stop: async () => {
        await stopChild(child);
      },
    };
  } finally {
    await rm(bootDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 停止子进程并**等到它真的退出**（导出为测试缝：升级链要能用假 child 单测）。
 *
 * 完成条件：观察到 `exit`，或 SIGKILL 后 1s 兜底放行。调用方依赖这个语义——例如
 * 释放 SQLite 句柄后才能删临时目录（Windows 上删被打开的文件直接 EPERM）。
 *
 * @param child - 目标子进程
 */
export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise<void>((resolve) => {
    let graceTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let reapFallbackTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let escalated = false;

    const finish = (): void => {
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (killTimer) clearTimeout(killTimer);
      if (reapFallbackTimer) clearTimeout(reapFallbackTimer);
      child.off('exit', finish);
      resolve();
    };

    child.once('exit', finish);

    /** 先礼后兵：SIGTERM 给 2s 自收摊，再 SIGKILL；SIGKILL 后仍等一拍 exit。单发。 */
    const escalate = (): void => {
      // settled 也要查：exit 先到之后，迟到的 send 错误回调仍可能进来
      // （通道写挂起 → 子进程退出 → 回调报错）。此时再武装定时器会在 stop() 已 resolve
      // 后打出假的 unobservable after SIGKILL 告警。
      if (settled || escalated) return;
      escalated = true;
      if (graceTimer) clearTimeout(graceTimer);
      try {
        child.kill('SIGTERM');
      } catch {
        /* 已经退出：exit 事件会/已把 promise 收掉 */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经退出（同上） */
        }
        // 兜底：SIGKILL 后若仍拿不到 exit（不可观测的僵尸），不让调用方永久挂起
        reapFallbackTimer = setTimeout(() => {
          console.warn(
            `[knowledge] child pid=${String(child.pid)} unobservable after SIGKILL; releasing stop() without exit`,
          );
          finish();
        }, 1_000);
        reapFallbackTimer.unref?.();
      }, 2_000);
      killTimer.unref?.();
    };

    if (child.connected) {
      graceTimer = setTimeout(escalate, 3_000);
      graceTimer.unref?.();
      try {
        // 通道刚断时 send 不抛异常，错误只进回调——必须由回调转入升级。
        child.send({ type: 'close' }, (err?: Error | null) => {
          if (err) escalate();
        });
      } catch {
        escalate();
      }
    } else {
      // 通道已断（等价于宿主硬死）：没有优雅关闭通道可走，直接终止并**等 exit**。
      escalate();
    }
  });
}
