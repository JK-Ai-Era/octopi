/**
 * Session-persisted compact views (model 2 / E4).
 * Key: (sessionId, agentId) → SessionData.contextCompacts[agentId].
 * contextCompact remains the primary/single-agent compatibility view.
 */

import type { ContextCompactSnapshot } from './context/types.js';
import type { SessionData } from './session-types.js';

/**
 * Read compact snapshot for an agent on a session.
 *
 * @param session - session data
 * @param agentId - target agent
 * @returns snapshot or undefined
 */
export function readSessionCompact(
  session: SessionData,
  agentId: string,
): ContextCompactSnapshot | undefined {
  const bucket = session.contextCompacts?.[agentId];
  if (bucket) return bucket;
  const primary = session.primaryAgentId ?? session.agentId;
  if (agentId === primary || !session.primaryAgentId) {
    return session.contextCompact;
  }
  return undefined;
}

/**
 * Write compact snapshot for an agent (E4: do not borrow another agent bucket).
 *
 * @param session - session data (mutated in place)
 * @param agentId - target agent
 * @param snap - snapshot; undefined clears the agent bucket
 */
export function writeSessionCompact(
  session: SessionData,
  agentId: string,
  snap: ContextCompactSnapshot | undefined,
): void {
  const map: Record<string, ContextCompactSnapshot> = { ...(session.contextCompacts ?? {}) };
  if (snap && (snap.summary || snap.lastProactiveMessageCount != null)) {
    map[agentId] = { ...snap };
  } else {
    delete map[agentId];
  }
  if (Object.keys(map).length > 0) {
    session.contextCompacts = map;
  } else {
    delete session.contextCompacts;
  }

  const primary = session.primaryAgentId ?? session.agentId;
  if (agentId === primary || !session.primaryAgentId) {
    if (snap && (snap.summary || snap.lastProactiveMessageCount != null)) {
      session.contextCompact = { ...snap };
    } else {
      delete session.contextCompact;
    }
  }
}
