/**
 * Skill 索引冻结与增量（设计 §7：冻结 + 增量 + 转正；arch/skill-creation-design.md）
 *
 * E8/B0 纪律的技能侧落法：
 * - **冻结**：会话首轮把技能索引固化（write-once），system prompt 的
 *   `<available_skills>` 之后逐字节稳定——中途技能变化不 bust 缓存前缀。
 * - **增量**：会话中途新增/更新/停用的技能进 snapshot 层（消息尾 content 侧，
 *   `<skill-delta>` 块，每轮随快照重发）。
 * - **转正**：新会话重新冻结 = 增量并入稳定索引（delta 归零）。
 *
 * 冻结的持久化载体是 session 附属文件（随会话归档搬迁），刻意避开
 * state.json 聚合（整聚合写回的读-改-写会与 runner 的 steps/tasks 写竞态）。
 */

import type { SkillIndexEntry } from '../extension/plugin-ecosystem/skills/index-render.js';

/** 冻结快照（write-once；text 与 entries 同源，text 即 system 份的逐字节内容） */
export interface FrozenSkillIndex {
  entries: SkillIndexEntry[];
  /** system 份的渲染文本（冻结后恒定） */
  text: string;
  frozenAt: number;
}

/**
 * 冻结快照存取（session 作用域，write-once 语义在实现侧）。
 * 实现在 integration 层（文件/存储），经装配注入——harness 不直依赖存储。
 */
export interface FrozenSkillIndexStore {
  /**
   * 读取冻结快照。
   *
   * @param sessionId - 会话 id
   * @returns 冻结快照；无记录或记录损坏时 null（调用方按「未冻结」处理并可重写）
   */
  load(sessionId: string): Promise<FrozenSkillIndex | null>;
  /**
   * 写入冻结快照（write-once：已有记录则保持先到者，不覆盖）。
   *
   * @param sessionId - 会话 id
   * @param index - 冻结快照
   */
  save(sessionId: string, index: FrozenSkillIndex): Promise<void>;
}

/** 技能集差异（增量块的素材） */
export interface SkillIndexDiff {
  added: SkillIndexEntry[];
  updated: SkillIndexEntry[];
  removed: SkillIndexEntry[];
}

/**
 * 计算当前技能集相对冻结集的差异。
 *
 * 判变键 = (id, description, filePath)：description 变影响索引语义，
 * filePath 变影响加载位置——两者都算 updated。
 *
 * @param frozen - 冻结时的技能集
 * @param current - 当前技能集
 * @returns 差异（三清单皆空 = 无变化）
 */
export function diffSkillIndex(
  frozen: readonly SkillIndexEntry[],
  current: readonly SkillIndexEntry[],
): SkillIndexDiff {
  const frozenById = new Map(frozen.map((e) => [e.id, e]));
  const currentById = new Map(current.map((e) => [e.id, e]));

  const added: SkillIndexEntry[] = [];
  const updated: SkillIndexEntry[] = [];
  const removed: SkillIndexEntry[] = [];

  for (const [id, entry] of currentById) {
    const before = frozenById.get(id);
    if (!before) {
      added.push(entry);
    } else if (before.description !== entry.description || before.filePath !== entry.filePath) {
      updated.push(entry);
    }
  }
  for (const [id, entry] of frozenById) {
    if (!currentById.has(id)) removed.push(entry);
  }
  return { added, updated, removed };
}

/**
 * 渲染 `<skill-delta>` 增量块（snapshot 层内容）。
 *
 * @param diff - 技能集差异（调用方保证至少一项非空）
 * @returns 增量块文本
 */
export function renderSkillDelta(diff: SkillIndexDiff): string {
  const lines: string[] = ['<skill-delta>'];
  lines.push(
    '  ATTENTION — SESSION-SCOPED OVERRIDE, not a turn-scoped pick:',
    '  this block stays authoritative for the whole session (it is re-sent each turn only',
    '  because snapshots replay last-only; later turns do NOT supersede it).',
    '  It supersedes the session-start skill index above: entries added/updated below are',
    '  usable now, and a removed skill must NOT be used anymore even though it still',
    '  appears in the stable index above and its files remain readable on disk.',
  );
  if (diff.added.length > 0) {
    lines.push('  <new_skills>');
    for (const e of diff.added) lines.push(renderEntry(e));
    lines.push('  </new_skills>');
  }
  if (diff.updated.length > 0) {
    lines.push('  <updated_skills>');
    for (const e of diff.updated) lines.push(renderEntry(e));
    lines.push('  </updated_skills>');
  }
  if (diff.removed.length > 0) {
    lines.push('  <removed_skills>');
    for (const e of diff.removed) lines.push(`    <name>${escapeXml(e.id)}</name>`);
    lines.push('  </removed_skills>');
  }
  lines.push('</skill-delta>');
  return lines.join('\n');
}

function renderEntry(e: SkillIndexEntry): string {
  return [
    '    <skill>',
    `      <name>${escapeXml(e.id)}</name>`,
    `      <description>${escapeXml(e.description)}</description>`,
    `      <path>${escapeXml(e.filePath)}</path>`,
    '    </skill>',
  ].join('\n');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
