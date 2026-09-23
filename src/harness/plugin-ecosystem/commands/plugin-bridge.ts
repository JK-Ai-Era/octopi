/**
 * Plugin registerCommand → CommandRouter 桥接
 */

import type { PluginManager } from '../plugins/manager.js';
import type { CommandDefinition, CommandResult } from './types.js';

export function pluginCommandsFromManager(pm: PluginManager): CommandDefinition[] {
  return pm.getCommands().map((cmd) => {
    const rawName = cmd.name.replace(/^\/+/, '');
    return {
      name: rawName,
      description: cmd.description ?? rawName,
      usage: `/${rawName}`,
      kind: 'control' as const,
      source: 'plugin' as const,
      risk: 'low' as const,
      invocableBy: ['principal', 'plugin'] as const,
      async execute(ctx): Promise<CommandResult> {
        try {
          const out = (await cmd.handler({
            sessionId: ctx.sessionId,
            agentId: ctx.agentId,
            args: ctx.args,
            raw: ctx.raw,
            principal: ctx.principal,
          })) as unknown;

          if (out && typeof out === 'object' && 'status' in (out as object) && 'display' in (out as object)) {
            return out as CommandResult;
          }
          const text =
            typeof out === 'string'
              ? out
              : out == null
                ? `/${rawName} ok`
                : JSON.stringify(out, null, 2);
          return {
            status: 'ok',
            display: { type: 'text', text },
          };
        } catch (err) {
          return {
            status: 'error',
            display: {
              type: 'text',
              text: `命令 /${rawName} 执行失败：${err instanceof Error ? err.message : String(err)}`,
            },
          };
        }
      },
    };
  });
}
