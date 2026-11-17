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
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { forkChildNodeOptions, stopForkedChild } from '../../fork-child.js';
import { createPrivateTempDir, writeSecretFileSync } from '../../file-mode.js';
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
  sqliteVec?: boolean | { extensionPath?: string; require?: boolean };
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
    sqliteVec: opts.sqliteVec,
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
  // 私有目录 + 真实权限收紧：boot 含 loopback token，Windows 上 `mode` 不生效。
  // 建目录之后的每一步都可能抛（写 secret、fork），而 `finally` 在 try 之外不生效——
  // 所以把它们全部纳入 try，失败时连目录（含 token）一起回收。
  const bootDir = createPrivateTempDir('octopi-kn-boot-');
  const bootPath = join(bootDir, 'boot.json');
  let child: ChildProcess;
  try {
    writeSecretFileSync(bootPath, JSON.stringify(buildKnowledgeServiceBootFile(opts)));
  } catch (err) {
    await rm(bootDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  try {
    // execPath 保持 process.execPath：Electron 下换捆绑 node 会切断 IPC
    child = fork(entry, [bootPath], forkChildNodeOptions({
      stdio: ['ignore', 'ignore', 'ignore'],
    }));
  } catch (err) {
    // fork 同步抛：boot 已写而子进程没机会读删——父进程兜底清 secret
    await rm(bootDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

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
    // 清理失败不改变启动结果，但必须留痕：这类 EPERM 正是"句柄未释放就删目录"的症状，
    // 静默吞掉会让下一轮排障从零开始。
    await rm(bootDir, { recursive: true, force: true }).catch((err: unknown) => {
      console.warn(`[knowledge] boot dir cleanup failed (${String(err)}): ${bootDir}`);
    });
  }
}

/**
 * 停止 knowledge 子进程并等待它退出（转调共享实现，预算为本服务的历史取值）。
 *
 * 语义与告警行为见 `stopForkedChild`：3s 优雅宽限 → SIGTERM → 2s → SIGKILL →
 * 1s 兜底放行。
 *
 * @param child - knowledge 子进程
 * @returns 子进程已退出（或兜底放行）时 resolve
 */
export function stopChild(child: ChildProcess): Promise<void> {
  return stopForkedChild(child, { graceMs: 3_000, termMs: 2_000, reapFallbackMs: 1_000, label: 'knowledge' });
}
