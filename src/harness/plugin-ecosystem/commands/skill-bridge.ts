/**
 * Skill → Command 桥接：SKILL.md frontmatter.command
 *
 * 规则见 arch/slash-commands.md §6.1
 */

import type { SkillManager } from '../skills/types.js';
import type {
  CommandDefinition,
  CommandResult,
  ExpandedMessages,
} from './types.js';
import { normalizeCommandName } from './parse.js';

const ARG_TOKEN = '$ARGUMENTS';

export function isValidCommandFieldName(raw: string): boolean {
  return normalizeCommandName(raw) !== null;
}

/** 将 SkillManager 中带 command 的 skill 转为 CommandDefinition 列表 */
export function skillCommandsFromManager(
  skills: SkillManager,
  loadBody: (skillId: string) => Promise<string | null>,
): CommandDefinition[] {
  const defs: CommandDefinition[] = [];
  for (const skill of skills.list()) {
    if (!skill.command) continue;
    const name = normalizeCommandName(skill.command);
    if (!name) continue;

    const expandFn = async (ctx: {
      args: string[];
    }): Promise<ExpandedMessages> => {
      const body = (await loadBody(skill.id)) ?? skill.description;
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
