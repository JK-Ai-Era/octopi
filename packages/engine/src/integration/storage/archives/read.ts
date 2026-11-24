/**
 * 冷备包只读访问 —— bundle → SessionData（P2：history port 冷备检索 / queryArchive 共用读法）
 *
 * 权威读法单源：解包到临时目录后走 `JsonlSessionStore.load`（与热库同一套
 * jsonl/state 合并语义），读完即清临时目录；不复制第二套解析。
 * `unpackBundle` 内含逐文件 sha256 校验：篡改/截断在此抛错（fail loud）。
 *
 * @module
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSessionFileName } from '@octopi-agent/core/session-filename.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import { JsonlSessionStore } from '../jsonl.js';
import { unpackBundle } from './bundle.js';

/**
 * bundle 相对路径（命名与 service 封存侧同源：`sessions/<toSessionFileName(id)>.tar.gz`）
 *
 * @param sessionId - 会话 id
 * @returns 相对 archivesDir 的包路径
 */
export function bundleRelativePath(sessionId: string): string {
  return `sessions/${toSessionFileName(sessionId)}.tar.gz`;
}

/**
 * bundle 绝对路径
 *
 * @param archivesDir - OCTOPI_HOME/archives
 * @param sessionId - 会话 id
 * @returns 包绝对路径
 */
export function bundlePathFor(archivesDir: string, sessionId: string): string {
  return join(archivesDir, bundleRelativePath(sessionId));
}

/**
 * 从封存包读回 SessionData（只读，不动注册表/热库）
 *
 * @param bundlePath - .tar.gz 包路径
 * @param sessionId - 会话 id（包内文件名由 toSessionFileName 派生）
 * @returns 会话数据；包内无该会话文件返回 null。包缺失/损坏抛错（调用侧决定降级）
 */
export async function readSessionFromBundle(
  bundlePath: string,
  sessionId: string,
): Promise<SessionData | null> {
  const dir = await mkdtemp(join(tmpdir(), 'octopi-bundle-read-'));
  try {
    await unpackBundle(bundlePath, dir);
    const store = new JsonlSessionStore({ sessionsDir: dir });
    return await store.load(sessionId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
