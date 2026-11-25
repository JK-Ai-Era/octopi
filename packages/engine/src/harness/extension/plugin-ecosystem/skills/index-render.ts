/**
 * Skill 索引渲染（单源）
 *
 * `formatForPrompt()`（manager）、冻结快照（SkillLayer freeze）与增量块
 * （SkillDeltaLayer）共用本渲染——三处格式漂移会让「冻结」和「实时」的
 * 索引看起来像两种技能，故收敛到此。
 */

/** 索引条目（渲染最小面：id/name/description/filePath + requiredTools 标注） */
export interface SkillIndexEntry {
  id: string;
  name: string;
  description: string;
  filePath: string;
  /** frontmatter allowed-tools（S4 失配标注用；旧冻结条目无此字段=不标注） */
  requiredTools?: string[];
}

/** XML 转义：防止 skill 名称或描述中的特殊字符破坏 XML 格式（与历史 manager 实现逐字节等价） */
function xmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 渲染 `<available_skills>` 索引（system prompt 形态）。
 *
 * @param entries - 可见技能条目（调用方负责 disableModelInvocation 过滤）
 * @param opts.availableTools - 当前 agent 可用工具名（S4：requiredTools 失配标注；
 *   缺省不标注——冻结字节稳定性优先，装配方自行决定是否比对）
 * @returns 索引块；空集返回 ''（与 formatForPrompt 历史行为一致）
 */
export function renderSkillIndexEntries(
  entries: readonly SkillIndexEntry[],
  opts?: { availableTools?: string[] },
): string {
  if (entries.length === 0) return '';

  const available = opts?.availableTools ? new Set(opts.availableTools) : undefined;
  const lines: string[] = ['<available_skills>'];
  for (const skill of entries) {
    lines.push('  <skill>');
    lines.push(`    <name>${xmlEscape(skill.id)}</name>`);
    lines.push(`    <description>${xmlEscape(skill.description)}</description>`);
    lines.push(`    <path>${xmlEscape(skill.filePath)}</path>`);
    // S4 失配标注（§12.5）：技能声明的工具在当前部署不可用——加载时即知，
    // 不让模型用时才发现（computeMissingTools 单源，增量块渲染共用）
    const missing = computeMissingTools(skill, available);
    if (missing.length > 0) {
      lines.push(`    <missing-tools>${xmlEscape(missing.join(', '))}</missing-tools>`);
    }
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  lines.push('');
  lines.push(
    'Load a skill with skill_read(id=<name>): no file = activate the SKILL.md body as ' +
      'session knowledge; file=<path> = consult one attachment on demand. ' +
      'The skill_* namespace is the only way to reach these files.',
  );

  return lines.join('\n');
}

/**
 * S4 失配标注计算（单源）：requiredTools 与当前可用工具集的差集。
 *
 * 索引渲染（renderSkillIndexEntries）与增量块渲染（renderSkillDelta）共用——
 * 两处各算会漂移（S4 标注曾漏进增量条目，2026-11-26 实测发现）。
 *
 * @param entry - 技能条目（无 requiredTools = 不标注）
 * @param available - 可用工具名集合；缺省 = 不标注（冻结字节稳定性优先）
 * @returns 缺失工具名列表（可能为空）
 */
export function computeMissingTools(
  entry: SkillIndexEntry,
  available?: ReadonlySet<string>,
): string[] {
  if (!available || !entry.requiredTools || entry.requiredTools.length === 0) return [];
  return entry.requiredTools.filter((t) => !available.has(t));
}
