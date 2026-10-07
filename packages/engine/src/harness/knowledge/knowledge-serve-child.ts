/**
 * Knowledge Service 独立子进程入口
 *
 * Gateway manageLocal 通过 fork 本文件拉起 Service：知识索引再重、再不稳，
 * 也不得与 Gateway 共进程/共命运。本进程是 knowledge.db 唯一写者。
 *
 * 启动协议：argv[2] = boot JSON 路径；就绪后 process.send({ type: 'ready', port })。
 * IPC 是 best-effort 通知：channel 断开时 HTTP 仍服务，不得因 send 崩进程。
 */
import { readFile, unlink } from 'node:fs/promises';
import { startKnowledgeService } from './serve.js';
import { acquireKnowledgeWriterLock } from './writer-lock.js';
import type { KnowledgeServiceToken } from './http-app.js';
import type { DocumentCapabilityConfig } from '../capabilities/document/factory.js';

interface BootFile {
  dbPath: string;
  host?: string;
  port?: number;
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
    embedding?: Record<string, unknown>;
  } | null;
}

function sendToParent(msg: Record<string, unknown>): void {
  if (typeof process.send !== 'function') return;
  try {
    process.send(msg, (err: Error | null) => {
      if (err) {
        // 父进程已退出 / 通道已断：HTTP 仍可服务
      }
    });
  } catch {
    // 同步 send 失败同样不致命
  }
}

async function main(): Promise<void> {
  const bootPath = process.argv[2];
  if (!bootPath) {
    throw new Error('knowledge-serve-child: missing boot file path');
  }
  const raw = await readFile(bootPath, 'utf8');
  const boot = JSON.parse(raw.replace(/^﻿/, '')) as BootFile;
  try {
    await unlink(bootPath);
  } catch {
    /* parent may already have cleaned up */
  }

  // 写者锁必须由真正打开 knowledge.db 的本进程持有
  const lock = await acquireKnowledgeWriterLock(boot.dbPath);

  const handle = await startKnowledgeService({
    dbPath: boot.dbPath,
    ...(boot.host != null ? { host: boot.host } : {}),
    ...(boot.port != null ? { port: boot.port } : {}),
    tokens: boot.tokens,
    autoRegisterPrincipals: true,
    documentConfig: boot.documentConfig ?? null,
    embeddingModels: boot.embeddingModels ?? null,
    embed: boot.embed ?? null,
    ...(boot.sqliteVecExtensionPath
      ? { sqliteVecExtensionPath: boot.sqliteVecExtensionPath }
      : {}),
  });

  let closing = false;
  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await handle.close();
    } catch {
      /* best-effort */
    }
    try {
      lock.release();
    } catch {
      /* best-effort */
    }
    process.exit(code);
  };

  process.on('message', (msg: { type?: string }) => {
    if (msg?.type === 'close') void shutdown(0);
  });
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
  // process.send 失败以 'error' 事件冒出；不监听会 Unhandled 打崩本进程
  process.on('error', () => {
    /* IPC channel noise; service keeps listening */
  });

  if (typeof process.send === 'function') {
    sendToParent({ type: 'ready', port: handle.port, pid: process.pid });
  } else {
    console.log(`[Knowledge] serve listening port=${handle.port} pid=${process.pid}`);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  if (typeof process.send === 'function') {
    sendToParent({ type: 'error', error: message });
  } else {
    console.error(`[Knowledge] serve failed: ${message}`);
  }
  process.exit(1);
});
