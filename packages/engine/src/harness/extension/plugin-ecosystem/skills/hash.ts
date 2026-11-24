/**
 * 技能目录内容哈希 — 审查绑定内容（arch/skill-creation-design.md §5）
 *
 * 「审查的是内容，不是名字」：哈希覆盖目录内全部文件的相对路径与字节，
 * 任何内容改动（含改名/增删文件）都导致哈希漂移 → 审查失效。
 * 排序后哈希保证同一目录树跨平台/跨枚举顺序稳定。
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * 计算技能目录的内容哈希（sha256）。
 *
 * 覆盖：每个常规文件的相对路径 + 内容字节（按相对路径排序）。
 * 符号链接不入哈希（validate 阶段已拒绝）；目录结构由文件相对路径蕴含。
 *
 * @param skillDir - 技能目录绝对路径
 * @returns `sha256:<hex>` 形态的内容哈希
 */
export function hashSkillDir(skillDir: string): string {
  const files: Array<{ rel: string; abs: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.isFile()) files.push({ rel: relative(skillDir, abs), abs });
    }
  };
  walk(skillDir);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const hash = createHash('sha256');
  for (const f of files) {
    // sep 归一为 `/`：跨平台同一树产出同一哈希
    hash.update(f.rel.split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(f.abs));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * 计算技能目录总字节数（安全阀用）。
 *
 * @param skillDir - 技能目录绝对路径
 * @returns 常规文件字节合计
 */
export function skillDirBytes(skillDir: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.isFile()) total += statSync(abs).size;
    }
  };
  walk(skillDir);
  return total;
}
