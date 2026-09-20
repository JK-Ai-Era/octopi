/**
 * Effective rights math (E6) + role catalog merge.
 */

import type {
  EffectiveSessionRights,
  ReadScope,
  SessionAclConfig,
  SessionRoleDefinition,
  SessionRights,
} from './types.js';
import { BUILTIN_SESSION_ROLES, L0_SESSION_RIGHTS_FLOOR } from './seed-roles.js';

const READ_SCOPE_RANK: Record<ReadScope, number> = {
  none: 0,
  summary_tail: 1,
  from_grant: 2,
  full: 3,
};

/**
 * Intersect two full rights (stricter wins).
 *
 * @param a - left rights
 * @param b - right rights
 * @returns intersection
 */
export function intersectRights(
  a: EffectiveSessionRights,
  b: EffectiveSessionRights,
): EffectiveSessionRights {
  return {
    canRun: a.canRun && b.canRun,
    readScope:
      READ_SCOPE_RANK[a.readScope] <= READ_SCOPE_RANK[b.readScope] ? a.readScope : b.readScope,
    writeMemory: a.writeMemory && b.writeMemory,
    canManageTasks: a.canManageTasks && b.canManageTasks,
    canHandoff: a.canHandoff && b.canHandoff,
  };
}

/**
 * Overlay explicit rights onto role defaults.
 *
 * Binding fields that are set **replace** defaults (then clamped to max/L0/agentMax).
 * Binding may raise a default toward role.max; it may not exceed max (clamped later).
 *
 * @param base - role defaults
 * @param overlay - participant override
 * @returns merged rights (not yet clamped to max)
 */
export function applyRightsOverlay(
  base: EffectiveSessionRights,
  overlay?: SessionRights,
): EffectiveSessionRights {
  if (!overlay) return { ...base };
  return {
    canRun: overlay.canRun ?? base.canRun,
    readScope: overlay.readScope ?? base.readScope,
    writeMemory: overlay.writeMemory ?? base.writeMemory,
    canManageTasks: overlay.canManageTasks ?? base.canManageTasks,
    canHandoff: overlay.canHandoff ?? base.canHandoff,
  };
}

/**
 * Whether `value` exceeds `ceiling` (illegal grant when true).
 *
 * @param value - proposed rights
 * @param ceiling - max rights
 * @returns true if any field is stronger than ceiling
 */
export function exceedsRightsCeiling(
  value: EffectiveSessionRights,
  ceiling: EffectiveSessionRights,
): boolean {
  return (
    (value.canRun && !ceiling.canRun) ||
    READ_SCOPE_RANK[value.readScope] > READ_SCOPE_RANK[ceiling.readScope] ||
    (value.writeMemory && !ceiling.writeMemory) ||
    (value.canManageTasks && !ceiling.canManageTasks) ||
    (value.canHandoff && !ceiling.canHandoff)
  );
}

/**
 * Role catalog: builtin seeds + config overrides/additions.
 */
export class SessionRoleCatalog {
  private roles = new Map<string, SessionRoleDefinition>();

  /**
   * Build catalog from optional host config.
   *
   * @param config - sessionAcl config; omitted → builtin only
   */
  constructor(config?: SessionAclConfig) {
    for (const role of BUILTIN_SESSION_ROLES) {
      this.roles.set(role.id, { ...role, defaults: { ...role.defaults }, max: role.max ? { ...role.max } : { ...role.defaults } });
    }
    if (config?.roles) {
      for (const role of config.roles) {
        const prev = this.roles.get(role.id);
        this.roles.set(role.id, {
          id: role.id,
          description: role.description ?? prev?.description,
          isBuiltin: prev?.isBuiltin ?? false,
          defaults: { ...role.defaults },
          max: role.max ? { ...role.max } : (prev?.max ? { ...prev.max } : { ...role.defaults }),
        });
      }
    }
  }

  /**
   * Get role definition
   *
   * @param roleId - role id
   * @returns definition or undefined
   */
  get(roleId: string): SessionRoleDefinition | undefined {
    return this.roles.get(roleId);
  }

  /**
   * List all roles
   *
   * @returns role definitions
   */
  list(): SessionRoleDefinition[] {
    return [...this.roles.values()];
  }

  /**
   * Whether role exists
   *
   * @param roleId - role id
   * @returns true if present
   */
  has(roleId: string): boolean {
    return this.roles.has(roleId);
  }
}

/**
 * Compute effective rights (E6).
 *
 * effective = (L0 without hard-deny handoff) ∩ role.max ∩ agent.max ∩ (defaults ⊕ binding)
 * then handoff is gated by engine policy `allowAgentInitiatedHandoff` (I3).
 *
 * @param input - role, optional agent max, optional participant override
 * @returns clamped effective rights
 */
export function computeEffectiveRights(input: {
  role: SessionRoleDefinition;
  agentMax?: SessionRights;
  participantRights?: SessionRights;
  allowAgentInitiatedHandoff?: boolean;
}): EffectiveSessionRights {
  const roleMax = input.role.max ?? input.role.defaults;
  const merged = applyRightsOverlay(input.role.defaults, input.participantRights);
  const agentCeiling: EffectiveSessionRights = {
    canRun: input.agentMax?.canRun ?? true,
    readScope: input.agentMax?.readScope ?? 'full',
    writeMemory: input.agentMax?.writeMemory ?? true,
    canManageTasks: input.agentMax?.canManageTasks ?? true,
    canHandoff: input.agentMax?.canHandoff ?? true,
  };
  // L0：canHandoff 不是永久 false 交集项；由引擎策略 + role.max 决定（I3）
  const l0: EffectiveSessionRights = {
    ...L0_SESSION_RIGHTS_FLOOR,
    canHandoff: input.allowAgentInitiatedHandoff === true,
  };
  const effective = intersectRights(
    intersectRights(intersectRights(l0, roleMax), agentCeiling),
    merged,
  );
  return effective;
}
