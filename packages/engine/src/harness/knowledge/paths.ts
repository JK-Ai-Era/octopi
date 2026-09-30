/**
 * Knowledge 数据面路径 — OCTOPI_HOME/knowledge/
 */

import { join } from 'node:path';

export interface KnowledgePaths {
  root: string;
  dbPath: string;
  cacheDir: string;
}

/**
 * 解析 Knowledge 服务数据面路径
 *
 * @param octopiHome - OCTOPI_HOME 绝对路径
 */
export function resolveKnowledgePaths(octopiHome: string): KnowledgePaths {
  const root = join(octopiHome, 'knowledge');
  return {
    root,
    dbPath: join(root, 'knowledge.db'),
    cacheDir: join(root, 'cache'),
  };
}
