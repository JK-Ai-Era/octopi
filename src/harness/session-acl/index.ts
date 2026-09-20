/**
 * Session ACL public exports (Phase E).
 */

export * from './types.js';
export { BUILTIN_SESSION_ROLES, L0_SESSION_RIGHTS_FLOOR } from './seed-roles.js';
export {
  SessionRoleCatalog,
  computeEffectiveRights,
  intersectRights,
  applyRightsOverlay,
  exceedsRightsCeiling,
} from './rights.js';
export { SessionAclService } from './service.js';
export type { AgentSessionAclHint } from './service.js';
export type { PrincipalRef, SessionSwitchMode, SwitchSessionResult } from './types.js';
export type { SessionSwitchRecord } from '../session-types.js';
export type { RunAuditRecord } from '../agent-runtime/types.js';