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
}): SessionRoleDefinition['defaults'] {
  return { ...input };
}

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
