/**
 * Compact key helper (constitution E4).
 * Compact is a Session-derived view, not Agent template state.
 * Memory key = (sessionId, agentId).
 */

/**
 * Build compact state key.
 *
 * @param sessionId - session id
 * @param agentId - agent id; omitted falls back to sessionId
 * @returns map key for engine/Agent compact state
 */
export function compactStateKey(sessionId: string, agentId?: string): string {
  if (!agentId) return sessionId;
  return sessionId + '::' + agentId;
}
