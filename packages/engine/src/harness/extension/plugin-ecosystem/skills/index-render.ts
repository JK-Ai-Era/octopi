/**
 * Skill 索引渲染（单源）
 *
 * `formatForPrompt()`（manager）、冻结快照（SkillLayer freeze）与增量块
 * （SkillDeltaLayer）共用本渲染——三处格式漂移会让「冻结」和「实时」的
 * 索引看起来像两种技能，故收敛到此。
 */

/** 索引条目（渲染最小面：id/name/description/filePath） */
export interface SkillIndexEntry {
  id: string;
  name: string;
  description: string;
  filePath: string;
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
 * @returns 索引块；空集返回 ''（与 formatForPrompt 历史行为一致）
 */
export function renderSkillIndexEntries(entries: readonly SkillIndexEntry[]): string {
  if (entries.length === 0) return '';

  const lines: string[] = ['<available_skills>'];
  for (const skill of entries) {
    lines.push('  <skill>');
    lines.push(`    <name>${xmlEscape(skill.id)}</name>`);
    lines.push(`    <description>${xmlEscape(skill.description)}</description>`);
    lines.push(`    <path>${xmlEscape(skill.filePath)}</path>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  lines.push('');
  lines.push(
    'Load a skill with file_read using the absolute <path> above (skill files are NOT under the workspace cwd). ' +
      'Example: file_read(path=<path of the skill you need>)',
  );

  return lines.join('\n');
}
