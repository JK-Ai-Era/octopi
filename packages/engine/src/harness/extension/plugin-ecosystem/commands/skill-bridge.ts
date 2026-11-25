/**
 * Skill → Command 桥接：SKILL.md frontmatter.command
 *
 * 规则见 arch/slash-commands.md §6.1
 */

import type { SkillLoadResult, SkillManager } from '../skills/types.js';
import type {
  CommandDefinition,
  CommandResult,
  ExpandedMessages,
} from './types.js';
import { normalizeCommandName } from './parse.js';

const ARG_TOKEN = '$ARGUMENTS';

/** refused kind → 警示后缀（F12：漂移≠停用≠未过审，文案不误导） */
function refusedSuffix(kind: 'hash_drift' | 'disabled' | 'not_approved' | 'invalid_id' | 'unreadable'): string {
  switch (kind) {
    case 'hash_drift':
      return ' (content changed after review — hash drift)';
    case 'disabled':
      return ' (skill is disabled)';
    case 'not_approved':
      return ' (skill is not approved yet)';
    case 'invalid_id':
    case 'unreadable':
      return '';
  }
}

export function isValidCommandFieldName(raw: string): boolean {
  return normalizeCommandName(raw) !== null;
}

/** 将 SkillManager 中带 command 的 skill 转为 CommandDefinition 列表 */
export function skillCommandsFromManager(
  skills: SkillManager,
  loadBody: (skillId: string) => Promise<SkillLoadResult>,
): CommandDefinition[] {
  const defs: CommandDefinition[] = [];
  for (const skill of skills.list()) {
    if (!skill.command) continue;
    const name = normalizeCommandName(skill.command);
    if (!name) continue;

    const expandFn = async (ctx: {
      args: string[];
    }): Promise<ExpandedMessages> => {
      const loaded = await loadBody(skill.id);
      // 消费面语义（设计 §12.3）：
      // - ok → 展开正文；- not_found → description 兜底（历史行为）；
      // - refused → **不展开正文**（审查的是内容不是名字），按 kind 分派文案
      //   （F12：漂移≠停用≠未过审——不把「disabled」说成「被篡改」）
      //   fail-loud：用户敲了命令必须得到明确反馈，绝不静默给篡改后内容
      const body =
        loaded.status === 'ok'
          ? loaded.body
          : loaded.status === 'refused'
            ? `${skill.description}\n\n> ⚠️ WARNING: this skill's instructions were NOT expanded${refusedSuffix(loaded.kind)}: ${loaded.reason}`
            : skill.description;
      const argsText = ctx.args.join(' ').trim();
      const content = body.includes(ARG_TOKEN)
        ? body.split(ARG_TOKEN).join(argsText)
        : argsText
          ? `${body}\n\n## Arguments\n${argsText}`
          : body;
      return {
        messages: [
          {
            role: 'user',
            content,
            metadata: { source: 'command', skillId: skill.id, command: name },
          },
        ],
      };
    };

    defs.push({
      name,
      description: skill.description,
      usage: `/${name} [args…]`,
      kind: 'prompt',
      source: 'skill',
      risk: 'low',
      invocableBy: ['principal'],
      expand: expandFn,
      async execute(ctx): Promise<CommandResult> {
        const expanded = await expandFn(ctx);
        return {
          status: 'ok',
          display: { type: 'text', text: `已展开 /${name}` },
          enterLoop: true,
          messages: expanded.messages,
        };
      },
    });
  }
  return defs;
}
