/**
 * Plugin registerCommand → CommandRouter 桥接
 */

import type { PluginManager } from '../plugins/manager.js';
import type { CommandDefinition, CommandResult } from './types.js';

export interface PluginCommandBridge {
  definition: CommandDefinition;
  ref: string;
}

/**
 * Mount effective plugin contributions without replacing author-declared metadata.
 * The ref is Host-assigned plugin identity; it is not supplied by the handler.
 *
 * @param pm - Manager whose effective contribution registry has been published
 * @returns Command definitions and stable plugin registration references
 */
export function pluginCommandsFromManager(pm: PluginManager): PluginCommandBridge[] {
  return pm.getCommands().map((cmd) => {
    const rawName = cmd.name.replace(/^\/+/, '');
    const definition: CommandDefinition = {
      name: rawName,
      description: cmd.description ?? rawName,
      usage: `/${rawName}`,
      kind: cmd.kind ?? 'control',
      source: 'plugin',
      ...(cmd.risk === undefined ? {} : { risk: cmd.risk }),
      ...(cmd.invocableBy === undefined ? {} : { invocableBy: cmd.invocableBy }),
      ...(cmd.args === undefined ? {} : { args: cmd.args }),
      ...(cmd.preempt === undefined ? {} : { preempt: cmd.preempt }),
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
    return { definition, ref: cmd.pluginId };
  });
}
