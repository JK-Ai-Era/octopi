/**
 * startKnowledgeServiceProcess — fork 独立子进程托管 Knowledge Service
 *
 * 为什么是进程而不是 Worker：知识索引重且稳定不可控，不得与 Gateway 共命运。
 * Worker 仍共享堆/OOM 与进程生命周期，只是把 event loop 挪开，不是故障隔离。
 *
 * fork 根因约束（与 `octopi serve` daemon 同款）：
 * - `execArgv: []`：禁止继承父进程 loader/inspect/NODE_OPTIONS 钩子
 * - 剥离 `NODE_CHANNEL_*`：父进程若是 IPC 子进程（vitest / daemon），继承会错绑通道
 * - `stdio` 不用 `inherit`：Windows 管道句柄继承会干扰 IPC
 * - Electron 宿主：`ELECTRON_RUN_AS_NODE=1` + **保持** `process.execPath`。
 *   换成捆绑 node.exe 当 execPath 会切断 Windows 上的 fork IPC。
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkerUrl } from '../../worker-path.js';
import type { KnowledgeServiceToken } from './http-app.js';
import type { DocumentCapabilityConfig } from '../capabilities/document/factory.js';

export interface KnowledgeServiceProcessOptions {
  dbPath: string;
  port?: number;
  host?: string;
  tokens: KnowledgeServiceToken[];
  documentConfig?: DocumentCapabilityConfig | null;
  embed?: {
    enabled?: boolean;
    embedBatch?: number;
    embedMinIntervalMs?: number;
    embedConcurrency?: number;
    embedSecretPolicy?: 'allow' | 'redact' | 'skip';
  };
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
  /** 发 close 并等待退出；超时 SIGTERM */
  stop(): Promise<void>;
}

function isElectronHost(): boolean {
  return (
    Boolean((process.versions as { electron?: string }).electron) ||
    /electron|MiMo\.exe/i.test(process.execPath)
  );
}

function childNodeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // 父进程可能是 IPC 子进程（vitest worker / octopi serve daemon）：不得把通道句柄带进孙进程
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_CHANNEL_SERIALIZATION;
  delete env.NODE_UNIQUE_ID;
  if (isElectronHost()) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return env;
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
  await writeFile(
    bootPath,
    JSON.stringify({
      dbPath: opts.dbPath,
      host: opts.host,
      port: opts.port ?? 18280,
      tokens: opts.tokens,
      documentConfig: opts.documentConfig ?? null,
      embed: opts.embed,
      sqliteVecExtensionPath: opts.sqliteVecExtensionPath,
      embeddingModels: opts.embeddingModels ?? null,
    }),
    'utf8',
  );

  // @types/node 的 ForkOptions 未声明 windowsHide 等字段，运行时有效
  // execPath 必须保持 process.execPath：Electron 下换捆绑 node 会切断 IPC
  const forkOpts: Parameters<typeof fork>[2] = {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
    execArgv: [],
    env: childNodeEnv(),
  } as Parameters<typeof fork>[2];
  const child = fork(entry, [bootPath], forkOpts);

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

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const hard = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 2_000);
      hard.unref?.();
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      if (child.connected) {
        child.send({ type: 'close' }, () => {
          /* send callback only observes channel errors; exit path resolves */
        });
      } else {
        clearTimeout(timer);
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        resolve();
      }
    } catch {
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      resolve();
    }
  });
}
