/**
 * 用户自定义命令 — agents/<id>/commands/*.md
 *
 * frontmatter: name / description / kind(默认 prompt) / usage
 * 正文为 prompt 模板；`$ARGUMENTS` 可选。
 * 仅支持 kind=prompt（文件无法表达 control handler）。
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandDefinition, ExpandedMessages } from './types.js';
import { normalizeCommandName } from './parse.js';

const ARG_TOKEN = '$ARGUMENTS';

interface UserCommandFrontmatter {
  name?: string;
  description?: string;
  kind?: string;
  usage?: string;
  [key: string]: string | undefined;
}

function parseFrontmatter(raw: string): { meta: UserCommandFrontmatter; body: string } | null {
  const text = raw.replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: UserCommandFrontmatter = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

/**
 * 从目录加载用户命令。非法 name / 无 name 跳过（不抛错）。
 * ref = 文件绝对路径，保证同文件重载 upsert、不同文件同名可冲突。
 */
export function loadUserCommandDefs(directory: string): Array<{
  definition: CommandDefinition;
  ref: string;
}> {
  if (!directory || !existsSync(directory)) return [];
  const defs: Array<{ definition: CommandDefinition; ref: string }> = [];

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const filePath = join(directory, file);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed?.meta.name) continue;
    const name = normalizeCommandName(parsed.meta.name);
    if (!name) continue;

    // 文件态只支持 prompt 模板；control/client 无 handler，一律按 prompt
    const body = parsed.body;
    const description = parsed.meta.description ?? name;
    const usage = parsed.meta.usage ?? `/${name} [args…]`;

    const expandFn = async (ctx: { args: string[] }): Promise<ExpandedMessages> => {
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
            metadata: { source: 'command', userCommand: name, file },
          },
        ],
      };
    };

    defs.push({
      ref: `user:${filePath}`,
      definition: {
        name,
        description,
        usage,
        kind: 'prompt',
        source: 'user',
        risk: 'low',
        invocableBy: ['principal'],
        expand: expandFn,
        async execute(ctx) {
          const expanded = await expandFn(ctx);
          return {
            status: 'ok',
            display: { type: 'text', text: `已展开 /${name}` },
            enterLoop: true,
            messages: expanded.messages,
          };
        },
      },
    });
  }

  return defs;
}
