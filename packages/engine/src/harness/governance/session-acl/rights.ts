/**
 * Effective rights math (E6) + role catalog merge.
 */

import type {
  EffectiveSessionRights,
  ReadScope,
  SessionAclConfig,
  SessionRoleDefinition,
  SessionRights,
  ToolRights,
} from './types.js';
import { BUILTIN_SESSION_ROLES, L0_SESSION_RIGHTS_FLOOR } from './seed-roles.js';
import {
  intersectToolRights,
  normalizeToolRights,
  toolRightsExceeds,
} from './tool-rights.js';

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
    toolRights: intersectToolRights(a.toolRights, b.toolRights),
  };
}

/**
 * Overlay explicit rights onto role defaults.
 *
 * Binding fields that are set **replace** defaults (then clamped to max/L0/agentMax).
 * Binding may raise a default toward role.max; it may not exceed max (clamped later).
 * `toolRights` is narrow-only at merge time via later intersection with ceilings.
 *
 * @param base - role defaults
 * @param overlay - participant override
 * @returns merged rights (not yet clamped to max)
 */
export function applyRightsOverlay(
  base: EffectiveSessionRights,
  overlay?: SessionRights,
): EffectiveSessionRights {
  if (!overlay) {
    return { ...base, toolRights: intersectToolRights(undefined, base.toolRights) };
  }
  return {
    canRun: overlay.canRun ?? base.canRun,
    readScope: overlay.readScope ?? base.readScope,
    writeMemory: overlay.writeMemory ?? base.writeMemory,
    canManageTasks: overlay.canManageTasks ?? base.canManageTasks,
    canHandoff: overlay.canHandoff ?? base.canHandoff,
    // SEC-2 toolRights are narrow-only: overlay intersects base (never expands).
    toolRights: intersectToolRights(base.toolRights, overlay.toolRights),
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
    (value.canHandoff && !ceiling.canHandoff) ||
    toolRightsExceeds(value.toolRights, ceiling.toolRights)
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
    // Preserve deny-all `allow: []`; empty config allow stays unrestricted.
    const copyFull = (r: EffectiveSessionRights): EffectiveSessionRights => ({
      ...r,
      toolRights: intersectToolRights(undefined, r.toolRights),
    });
    // max.toolRights omitted → inherit defaults (do not silently open the ceiling)
    const copyMax = (
      max: EffectiveSessionRights | undefined,
      defaults: EffectiveSessionRights,
    ): EffectiveSessionRights => {
      if (!max) return copyFull(defaults);
      const m = copyFull(max);
      if (max.toolRights === undefined) {
        m.toolRights = intersectToolRights(undefined, defaults.toolRights);
      }
      return m;
    };
    for (const role of BUILTIN_SESSION_ROLES) {
      const defaults = copyFull(role.defaults);
      this.roles.set(role.id, {
        ...role,
        defaults,
        max: copyMax(role.max, role.defaults),
      });
    }
    if (config?.roles) {
      for (const role of config.roles) {
        const prev = this.roles.get(role.id);
        const defaults = copyFull(role.defaults);
        this.roles.set(role.id, {
          id: role.id,
          description: role.description ?? prev?.description,
          isBuiltin: prev?.isBuiltin ?? false,
          defaults,
          max: role.max
            ? copyMax(role.max, role.defaults)
            : (prev?.max ? copyFull(prev.max) : copyMax(undefined, role.defaults)),
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
    // undefined → unrestricted; preserve explicit allow:[] deny-all
    toolRights: intersectToolRights(undefined, input.agentMax?.toolRights),
  };
  // L0：canHandoff 不是永久 false 交集项；由引擎策略 + role.max 决定（I3）
  const l0: EffectiveSessionRights = {
    ...L0_SESSION_RIGHTS_FLOOR,
    toolRights: intersectToolRights(undefined, L0_SESSION_RIGHTS_FLOOR.toolRights),
    canHandoff: input.allowAgentInitiatedHandoff === true,
  };
  const roleMaxFull: EffectiveSessionRights = {
    ...roleMax,
    toolRights: intersectToolRights(undefined, roleMax.toolRights),
  };
  const effective = intersectRights(
    intersectRights(intersectRights(l0, roleMaxFull), agentCeiling),
    merged,
  );
  return effective;
}

/**
 * readScope 从宽到严的次序（越靠后越受限）
 *
 * `arch/delegation.md` D3：子的 rights 只能收紧不能放宽。
 */
const READ_SCOPE_ORDER: readonly ReadScope[] = ['full', 'from_grant', 'summary_tail', 'none'];

/**
 * 取两个 `SessionRights` 中**更严**的一侧（逐轴收紧）
 *
 * 用于叠加一个额外的权利天花板（如委派时传入的 `rightsCeiling`，`arch/delegation.md` D3）：
 * 结果在每一根轴上都不宽于任一入参。缺省轴（undefined）表示该轴无额外限制，不参与收紧。
 *
 * @param a - 第一层天花板（可缺省）
 * @param b - 第二层天花板（可缺省）
 * @returns 收紧后的天花板；两者皆缺省时返回 undefined
 */
export function tightenSessionRights(
  a: SessionRights | undefined,
  b: SessionRights | undefined,
): SessionRights | undefined {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return { ...a };

  const pickBool = (x?: boolean, y?: boolean): boolean | undefined => {
    if (x === undefined) return y;
    if (y === undefined) return x;
    return x && y;
  };

  const pickScope = (x?: ReadScope, y?: ReadScope): ReadScope | undefined => {
    if (x === undefined) return y;
    if (y === undefined) return x;
    // 下标越大越受限
    return READ_SCOPE_ORDER.indexOf(x) >= READ_SCOPE_ORDER.indexOf(y) ? x : y;
  };

  return {
    canRun: pickBool(a.canRun, b.canRun),
    readScope: pickScope(a.readScope, b.readScope),
    writeMemory: pickBool(a.writeMemory, b.writeMemory),
    canManageTasks: pickBool(a.canManageTasks, b.canManageTasks),
    canHandoff: pickBool(a.canHandoff, b.canHandoff),
    toolRights: intersectToolRights(a.toolRights, b.toolRights),
  };
}
