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

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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

/**
 * 目录指纹：AGENTS.md + persona/*.md 的 path:mtimeMs:size
 *
 * 仅 stat，不读正文；文件增删改都会改变指纹。
 */
async function fingerprintDir(agentDir: string): Promise<string> {
  const parts: string[] = [];

  try {
    const st = await stat(join(agentDir, 'AGENTS.md'));
    parts.push(`AGENTS.md:${st.mtimeMs}:${st.size}`);
  } catch {
    // 文件可选
  }

  const personaDir = join(agentDir, 'persona');
  try {
    const files = (await readdir(personaDir))
      .filter((e) => e.endsWith('.md'))
      .sort();
    for (const file of files) {
      try {
        const st = await stat(join(personaDir, file));
        parts.push(`${file}:${st.mtimeMs}:${st.size}`);
      } catch {
        // 与 readdir 之间的竞态删除：忽略该文件
      }
    }
  } catch {
    // persona/ 可选
  }

  return parts.join(';');
}

/**
 * PersonaSource — 带指纹缓存的 persona 加载器
 *
 * 每次 load() 先 stat 相关文件；指纹不变复用缓存，变则重读。
 * 因此「改 persona 文件 → 下一轮 run 生效」，无需重启进程。
 */
export class PersonaSource {
  private cache = new Map<string, { content: string; fingerprint: string }>();

  /**
   * 加载（并缓存）一个或多个 agent 目录的组合 persona
   *
   * @param agentDirs - agent 目录，按优先级从低到高
   * @returns 拼接后的 system prompt
   */
  async load(...agentDirs: string[]): Promise<string> {
    if (agentDirs.length === 0) return '';
    const key = agentDirs.map((d) => resolve(d)).join('\0');
    const fingerprint = await fingerprintDirs(agentDirs);
    const hit = this.cache.get(key);
    if (hit && hit.fingerprint === fingerprint) {
      return hit.content;
    }
    const content =
      agentDirs.length === 1
        ? await loadPersona(agentDirs[0])
        : await composePersonas(...agentDirs);
    this.cache.set(key, { content, fingerprint });
    return content;
  }

  /** 丢弃指定目录组合的缓存 */
  invalidate(...agentDirs: string[]): void {
    if (agentDirs.length === 0) {
      this.cache.clear();
      return;
    }
    const key = agentDirs.map((d) => resolve(d)).join('\0');
    this.cache.delete(key);
  }

  /** 清空全部缓存 */
  clear(): void {
    this.cache.clear();
  }
}

async function fingerprintDirs(agentDirs: string[]): Promise<string> {
  const parts: string[] = [];
  for (const dir of agentDirs) {
    parts.push(await fingerprintDir(dir));
  }
  return parts.join('|');
}
