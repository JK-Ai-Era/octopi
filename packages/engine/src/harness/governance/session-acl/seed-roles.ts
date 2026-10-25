/**
 * Factory session roles (arch/session-acl.md §2; constitution §4 / E6).
 * specialist & reviewer: readScope=full; specialist writeMemory+canManageTasks=true.
 * Factory roles have canHandoff=false.
 */

import type { SessionRoleDefinition } from './types.js';

function rights(input: {
  canRun: boolean;
  readScope: SessionRoleDefinition['defaults']['readScope'];
  writeMemory: boolean;
  canManageTasks: boolean;
  canHandoff: boolean;
  toolRights?: SessionRoleDefinition['defaults']['toolRights'];
}): SessionRoleDefinition['defaults'] {
  return {
    canRun: input.canRun,
    readScope: input.readScope,
    writeMemory: input.writeMemory,
    canManageTasks: input.canManageTasks,
    canHandoff: input.canHandoff,
    // Factory roles ship unrestricted tool surface (SEC-2: omit = no extra limit)
    toolRights: input.toolRights ?? { allow: undefined, deny: [], denyCapabilities: [] },
  };
}

/**
 * 提权请求者授权（ops §8.6 拍板：T1 缺省仅 owner 可请求）：
 * 非 owner 角色默认 deny `priv_exec`——缺权参与者在 toolRights 层即拒，
 * 连确认闸都到不了。owner 显式不受限。
 */
const NON_OWNER_PRIVILEGE: SessionRoleDefinition['defaults']['toolRights'] = {
  allow: undefined,
  deny: ['priv_exec'],
  denyCapabilities: [],
};

/** Built-in five-role catalog (v1: no consultant) */
export const BUILTIN_SESSION_ROLES: SessionRoleDefinition[] = [
  {
    id: 'owner',
    description: 'Primary accountable agent on the session',
    isBuiltin: true,
    defaults: rights({
      canRun: true,
      readScope: 'full',
      writeMemory: true,
      canManageTasks: true,
      canHandoff: false,
    }),
  },
  {
    id: 'specialist',
    description: 'Relay/expert: full context, own memory + task progress; not primary',
    isBuiltin: true,
    defaults: rights({
      canRun: true,
      readScope: 'full',
      writeMemory: true,
      canManageTasks: true,
      toolRights: NON_OWNER_PRIVILEGE,
      canHandoff: false,
    }),
  },
  {
    id: 'reviewer',
    description: 'Audit/review: full context, read-only',
    isBuiltin: true,
    defaults: rights({
      canRun: true,
      readScope: 'full',
      writeMemory: false,
      canManageTasks: false,
      toolRights: NON_OWNER_PRIVILEGE,
      canHandoff: false,
    }),
  },
  {
    id: 'operator',
    description: 'Side-channel tool execution: minimal exposure',
    isBuiltin: true,
    defaults: rights({
      canRun: true,
      readScope: 'none',
      writeMemory: false,
      canManageTasks: false,
      toolRights: NON_OWNER_PRIVILEGE,
      canHandoff: false,
    }),
  },
  {
    id: 'steward',
    description: 'Session governance / extraction coordination',
    isBuiltin: true,
    defaults: rights({
      canRun: true,
      readScope: 'full',
      writeMemory: true,
      canManageTasks: true,
      toolRights: NON_OWNER_PRIVILEGE,
      canHandoff: false,
    }),
  },
];

/**
 * Engine L0 floor.
 *
 * `canHandoff` is **policy-gated**, not a permanent false intersection:
 * effective handoff = `allowAgentInitiatedHandoff` ∧ role.max ∧ agent.max ∧ binding (I3/E6).
 * Factory roles still ship `canHandoff=false`.
 */
export const L0_SESSION_RIGHTS_FLOOR = rights({
  canRun: true,
  readScope: 'full',
  writeMemory: true,
  canManageTasks: true,
  canHandoff: false,
});
