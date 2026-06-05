/**
 * PersonaLoader — 文件式人格加载器
 *
 * 从 workspace 目录加载 persona 文件，拼接为 system prompt。
 *
 * 文件约定（按优先级）：
 * - AGENTS.md    — 操作指令
 * - SOUL.md      — 人格特质、语调
 * - IDENTITY.md  — 身份定义
 * - USER.md      — 用户上下文
 * - TOOLS.md     — 工具使用说明
 * - MEMORY.md    — 长期记忆
 * - *.md          — 任意扩展文件（按字母序）
 *
 * 设计要点：
 * - 所有文件都是可选的
 * - 文件之间用分隔符分隔
 * - 支持组合多个 persona 目录（叠加）
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';

/** 文件加载优先级 */
const PRIORITY_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'MEMORY.md',
];

/** 分隔符 */
const SEPARATOR = '\n\n---\n\n';

/**
 * 从目录加载 persona
 *
 * @param workspace - persona 文件目录
 * @returns 拼接后的 system prompt
 */
export async function loadPersona(workspace: string): Promise<string> {
  const parts: string[] = [];
  const loaded = new Set<string>();

  // 1. 按优先级加载
  for (const file of PRIORITY_FILES) {
    const content = await readFileSafe(join(workspace, file));
    if (content) {
      parts.push(content);
      loaded.add(file.toLowerCase());
    }
  }

  // 2. 加载其他 .md 文件（按字母序）
  try {
    const entries = await readdir(workspace);
    const mdFiles = entries
      .filter(e => e.endsWith('.md') && !loaded.has(e.toLowerCase()))
      .sort();

    for (const file of mdFiles) {
      const content = await readFileSafe(join(workspace, file));
      if (content) {
        parts.push(content);
      }
    }
  } catch {
    // 目录不存在或不可读，忽略
  }

  return parts.join(SEPARATOR);
}

/**
 * 组合多个 persona
 *
 * 基础 persona → 领域 persona → 场景 persona
 * 后面的会覆盖/补充前面的。
 *
 * @param workspaces - persona 目录列表（按优先级从低到高）
 * @returns 组合后的 system prompt
 */
export async function composePersonas(...workspaces: string[]): Promise<string> {
  const parts: string[] = [];

  for (const ws of workspaces) {
    const content = await loadPersona(ws);
    if (content) {
      parts.push(content);
    }
  }

  return parts.join(SEPARATOR);
}

/**
 * 安全读取文件
 */
async function readFileSafe(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}
