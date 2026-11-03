/** Plugin Tool mounting and authorization shared by ToolBus, Agent, and Gateway. */

import type { RegisteredTool, ToolPolicy, ToolSource } from '@octopi-agent/core/types.js';
import type { PluginToolRecord } from '../plugins/contribution-registry.js';

/** Plugin Tools never inherit builtin's empty-allow visibility. */
export function isPluginToolPermitted(tool: RegisteredTool, policy?: ToolPolicy): boolean {
  return isPluginToolCallPermitted(tool.definition.name, tool.source, policy);
}

/** AgentTool/Runner projection variant: no handler is needed for policy evaluation. */
export function isPluginToolCallPermitted(
  name: string,
  source: ToolSource | undefined,
  policy?: ToolPolicy,
): boolean {
  if (source?.kind !== 'plugin') return true;
  const allow = policy?.allow ?? [];
  if (!(allow.includes('*') || allow.includes(name))) return false;
  if (policy?.deny?.includes('*') || policy?.deny?.includes(name)) return false;
  return true;
}

/** Adapter boundary: the host, not the plugin, assigns the contribution identity. */
export function pluginToolToRegisteredTool(record: PluginToolRecord): RegisteredTool {
  const source: ToolSource = { kind: 'plugin', origin: record.pluginId, trustLevel: 'third-party' };
  return {
    definition: record.definition,
    handler: record.handler,
    source,
    executionMode: record.executionMode ??
      (record.definition.capabilities?.includes('fs-write') ? 'sequential' : undefined),
  };
}

/** Mount only explicitly permitted contributions into an Agent's local ToolBus. */
export function mountPluginTools(
  records: readonly PluginToolRecord[],
  agentId: string,
  policy: ToolPolicy | undefined,
  registerForAgent: (agentId: string, tool: RegisteredTool) => void,
): RegisteredTool[] {
  const mounted: RegisteredTool[] = [];
  for (const record of records) {
    const tool = pluginToolToRegisteredTool(record);
    if (!isPluginToolPermitted(tool, policy)) continue;
    registerForAgent(agentId, tool);
    mounted.push(tool);
  }
  return mounted;
}
