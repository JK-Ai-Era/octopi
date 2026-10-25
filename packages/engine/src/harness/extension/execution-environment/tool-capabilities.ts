/**
 * Tool capability tags (D5-a). Reduced surface strips `exec` / `egress` /
 * `send` / `dynamic-code` / `runner`. Name-based fallback is only for builtins
 * that are listed here; unknown tools are rejected on reduced (unknown-reject).
 *
 * `vcs` is intentionally **not** stripped: local git porcelain (fixed argv
 * allowlist, hooks disabled) stays available so workspace/untrusted agents can
 * still commit/diff without a shell.
 */

import type { ToolCapability } from '@octopi-agent/core/types.js';

export type { ToolCapability };

/** Capabilities that are denied on the reduced tool surface. */
export const REDUCED_DENIED_CAPABILITIES = [
  'exec',
  'egress',
  'send',
  'dynamic-code',
  /** project_run executes workspace-defined scripts (code execution) */
  'runner',
  /** host introspection (process table/argv) — engine-side data bypasses the jail's "cannot see host processes" boundary */
  'host-read',
] as const satisfies readonly ToolCapability[];

/**
 * Builtin name → capability tags. Keep in sync with each tool definition's
 * `capabilities` field (backfilled for every builtin).
 */
export const BUILTIN_TOOL_CAPABILITIES: Record<string, ToolCapability[]> = {
  shell: ['exec'],
  file_read: ['fs-read'],
  file_write: ['fs-write'],
  file_edit: ['fs-write', 'fs-read'],
  file_delete: ['fs-write'],
  file_list: ['fs-read'],
  file_search: ['fs-read'],
  file_mkdir: ['fs-write'],
  file_rmdir: ['fs-write'],
  file_rename: ['fs-write'],
  file_copy: ['fs-write', 'fs-read'],
  file_stat: ['fs-read'],
  // Local VCS porcelain (spawn git argv allowlist; hooks disabled)
  git_status: ['vcs', 'fs-read'],
  git_diff: ['vcs', 'fs-read'],
  git_log: ['vcs', 'fs-read'],
  git_show: ['vcs', 'fs-read'],
  git_commit: ['vcs', 'fs-write'],
  git_branch: ['vcs', 'fs-write'],
  git_restore: ['vcs', 'fs-write'],
  // Package / project tooling
  package_edit: ['fs-write', 'fs-read'],
  project_run: ['runner'],
  package_install: ['egress', 'runner'],
  document_read: ['fs-read'],
  document_probe: ['fs-read'],
  env_info: ['fs-read'],
  // 只读进程诊断（ops P1）：宿主内省（进程表/argv），reduced 面剥掉（host-read）
  process_list: ['host-read'],
  // exec 标签：reduced 面剥掉提权通道（降能力不降墙）
  priv_exec: ['exec'],
  http_request: ['egress'],
  web_search: ['egress'],
  ask_user: [],
  memory_store: ['memory'],
  memory_search: ['memory'],
  knowledge_search: ['fs-read'],
  knowledge_read: ['fs-read'],
  session_search: ['fs-read'],
  session_read: ['fs-read'],
  // Session task tools (session/tasks/tools.ts) — tagged via resolve as needed
  task_create: ['fs-write'],
  task_list: ['fs-read'],
  task_plan: ['fs-write'],
  task_complete: ['fs-write'],
  task_pause: ['fs-write'],
  task_resume: ['fs-write'],
  task_drop: ['fs-write'],
  task_note: ['fs-write'],
};

/**
 * Resolve capabilities for a tool.
 *
 * @param toolName - registered tool name
 * @param explicit - capabilities from ToolDefinition (preferred)
 * @returns tags, or null when unknown
 */
/** Runtime registry: ToolBus register writes definition.capabilities here. */
type RegisteredCaps = ToolCapability[] | 'unknown';
const registeredCapabilities = new Map<string, RegisteredCaps>();

/**
 * Record capabilities for a registered tool (called from ToolBus.register).
 * Untagged registration is stored as `unknown` so a third-party tool cannot
 * inherit the builtin name map by shadowing a builtin name (P1-2 residual).
 *
 * @param toolName - registered name
 * @param capabilities - definition.capabilities (undefined = untagged → unknown)
 */
export function registerToolCapabilities(
  toolName: string,
  capabilities?: readonly string[] | null,
): void {
  const n = toolName.toLowerCase();
  if (capabilities && capabilities.length > 0) {
    registeredCapabilities.set(n, [...capabilities] as ToolCapability[]);
    return;
  }
  if (capabilities && capabilities.length === 0) {
    registeredCapabilities.set(n, []);
    return;
  }
  // Untagged: do not fall back to BUILTIN_TOOL_CAPABILITIES for this name
  registeredCapabilities.set(n, 'unknown');
}

/**
 * Resolve capabilities for a tool.
 *
 * Precedence: explicit arg → runtime registry → builtin name map.
 * Explicit `[]` is authoritative (no dangerous caps). Unknown → null.
 *
 * @param toolName - registered tool name
 * @param explicit - capabilities from ToolDefinition (preferred)
 * @returns tags, or null when unknown
 */
export function resolveToolCapabilities(
  toolName: string,
  explicit?: readonly string[] | null,
): ToolCapability[] | null {
  if (explicit !== undefined && explicit !== null) {
    return [...explicit] as ToolCapability[];
  }
  const n = toolName.toLowerCase();
  const reg = registeredCapabilities.get(n);
  if (reg === 'unknown') return null;
  if (reg) return [...reg];
  // Unregistered: builtin name map only (tests / pre-register probes)
  const builtin = BUILTIN_TOOL_CAPABILITIES[n];
  if (builtin) return [...builtin];
  return null;
}

/**
 * Whether any capability is denied on the reduced surface.
 *
 * @param caps - resolved capability tags
 * @returns true when the tool must be stripped
 */
export function deniesReducedSurface(caps: readonly string[]): boolean {
  return caps.some((c) => (REDUCED_DENIED_CAPABILITIES as readonly string[]).includes(c));
}
