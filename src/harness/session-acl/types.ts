/**
 * Session ACL types (constitution E6 / I3 / I6).
 * Rights are engine-policy fields, not host human IAM.
 */

/** Information visibility for a Run on a Session */
export type ReadScope = 'full' | 'from_grant' | 'summary_tail' | 'none';

/** Session participation rights (partial overrides allowed) */
export interface SessionRights {
  canRun?: boolean;
  readScope?: ReadScope;
  /** May write THIS agent's memory store only (E3) */
  writeMemory?: boolean;
  canManageTasks?: boolean;
  /** Factory roles all false; host-controlled handoff only by default */
  canHandoff?: boolean;
}

/** Full rights used for effective intersection */
export interface EffectiveSessionRights {
  canRun: boolean;
  readScope: ReadScope;
  writeMemory: boolean;
  canManageTasks: boolean;
  canHandoff: boolean;
}

/** Role catalog entry (config seed or host override) */
export interface SessionRoleDefinition {
  id: string;
  description?: string;
  /** Default rights when participant has no override */
  defaults: EffectiveSessionRights;
  /** Hard ceiling; overrides may not exceed max */
  max?: EffectiveSessionRights;
  /** Built-in factory seed (not host-defined) */
  isBuiltin?: boolean;
}

/** Participant binding on a session (model 2) */
export interface SessionParticipant {
  sessionId: string;
  agentId: string;
  roleId: string;
  /** Explicit rights override (clamped to role.max ∩ agent.max) */
  rights?: SessionRights;
  grantedBy?: string;
  reason?: string;
  grantSeq: number;
  grantedAt: number;
  revokedAt?: number;
}

/** Host switch defaults (preferred vs handoff) */
export interface SessionAclSwitchDefaults {
  preferredOnly?: boolean;
  consultGrantRole?: string;
  requireExplicitHandoff?: boolean;
}

/** octopi.json `sessionAcl` block */
export interface SessionAclConfig {
  /** Optional role overrides / additions (same id replaces seed) */
  roles?: Array<{
    id: string;
    description?: string;
    defaults: EffectiveSessionRights;
    max?: EffectiveSessionRights;
  }>;
  switchDefaults?: SessionAclSwitchDefaults;
  /** Engine default false (I3): agent cannot self-handoff */
  allowAgentInitiatedHandoff?: boolean;
}

/** authorizeRun result */
export interface AuthorizeRunResult {
  ok: boolean;
  reason?: string;
  roleId?: string;
  rights?: EffectiveSessionRights;
  /** Whether this call auto-bound primary as owner */
  autoBoundOwner?: boolean;
}

/** grant result */
export interface GrantResult {
  ok: boolean;
  reason?: string;
  participant?: SessionParticipant;
}

/** Structured Principal / Intent fields (I6 — engine does not NLU permissions) */
export interface PrincipalRef {
  /** Host / tenant / service / timer / subsystem / agent id */
  actorId?: string;
  actorType?: 'host' | 'user' | 'agent' | 'service' | 'timer' | 'subsystem';
  tenantId?: string;
  /** Structured intent: run | switch_preferred | consult | handoff | grant | … */
  intent?: string;
}

/** Switch modes (Accountability vs Agency) */
export type SessionSwitchMode = 'preferred' | 'handoff';

/** switch() result */
export interface SwitchSessionResult {
  ok: boolean;
  reason?: string;
  mode?: SessionSwitchMode;
  preferredAgentId?: string;
  primaryAgentId?: string;
  grantedRoleId?: string;
}
