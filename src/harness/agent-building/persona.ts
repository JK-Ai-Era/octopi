/**
 * PersonaLoader — 文件式人格加载器
 *
 * 文件约定：
 * - AGENTS.md（agent 根目录）— 主 persona 文件，最先加载
 * - persona/ 目录下的所有 .md 文件 — 补充 persona，按文件名字母序加载
 *   - 用数字前缀控制顺序：10-soul.md < 20-identity.md < 30-user.md
 *   - 无前缀的排在最后
 *
 * 设计要点：
 * - 所有文件都是可选的
 * - 文件之间用分隔符分隔
 * - 支持组合多个 persona 目录（叠加）
 * - 扩展时只加文件，不改代码
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** 分隔符 */
const SEPARATOR = '\n\n---\n\n';

/**
 * 加载 agent 的完整 persona
 *
 * @param agentDir - agent 根目录（包含 AGENTS.md 和 persona/ 子目录）
 * @returns 拼接后的 system prompt
 */
export async function loadPersona(agentDir: string): Promise<string> {
  const parts: string[] = [];

  // 1. 加载根目录的 AGENTS.md（行业惯例，最先加载）
  const agentsMd = await readFileSafe(join(agentDir, 'AGENTS.md'));
  if (agentsMd) {
    parts.push(agentsMd);
  }

  // 2. 加载 persona/ 目录下的所有 .md 文件（按文件名字母序）
  const personaDir = join(agentDir, 'persona');
  try {
    const entries = await readdir(personaDir);
    const mdFiles = entries
      .filter(e => e.endsWith('.md'))
      .sort(); // 字母序，数字前缀自然排序

    for (const file of mdFiles) {
      const content = await readFileSafe(join(personaDir, file));
      if (content) {
        parts.push(content);
      }
    }
  } catch {
    // persona/ 目录不存在，忽略
  }

  return parts.join(SEPARATOR);
}

/**
 * 组合多个 persona
 *
 * 基础 persona → 领域 persona → 场景 persona
 * 后面的会覆盖/补充前面的。
 *
 * @param agentDirs - agent 目录列表（按优先级从低到高）
 * @returns 组合后的 system prompt
 */
export async function composePersonas(...agentDirs: string[]): Promise<string> {
  const parts: string[] = [];

  for (const dir of agentDirs) {
    const content = await loadPersona(dir);
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