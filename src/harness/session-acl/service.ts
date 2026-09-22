/**
 * Session ACL service: grant/revoke + authorizeRun (E6).
 * v1: in-memory + SessionData.participants; no role DB.
 */

import type { SessionData, SessionSwitchRecord } from '../session-types.js';
import type { Message } from '../../core/types.js';
import {
  SessionRoleCatalog,
  computeEffectiveRights,
  exceedsRightsCeiling,
} from './rights.js';
import type {
  AuthorizeRunResult,
  EffectiveSessionRights,
  GrantResult,
  PrincipalRef,
  SessionAclConfig,
  SessionParticipant,
  SessionRights,
  SessionSwitchMode,
  SwitchSessionResult,
} from './types.js';

/** Agent template ACL ceilings (L1) */
export interface AgentSessionAclHint {
  suggestedSessionRole?: string;
  maxSessionRights?: SessionRights;
}

/**
 * Session ACL service
 */
export class SessionAclService {
  readonly catalog: SessionRoleCatalog;
  private allowAgentInitiatedHandoff: boolean;
  private grantSeqBySession = new Map<string, number>();
  private readonly switchConfig: Required<NonNullable<SessionAclConfig['switchDefaults']>>;

  /**
   * @param config - optional sessionAcl host config
   */
  constructor(config?: SessionAclConfig) {
    this.catalog = new SessionRoleCatalog(config);
    this.allowAgentInitiatedHandoff = config?.allowAgentInitiatedHandoff === true;
    this.switchConfig = {
      preferredOnly: config?.switchDefaults?.preferredOnly ?? true,
      consultGrantRole: config?.switchDefaults?.consultGrantRole ?? 'specialist',
      requireExplicitHandoff: config?.switchDefaults?.requireExplicitHandoff ?? true,
    };
  }

  /**
   * Whether effective rights allow agent-initiated handoff under engine policy.
   *
   * @param rights - effective rights
   * @returns true only when engine policy and role max both allow
   */
  allowsAgentHandoff(rights: EffectiveSessionRights): boolean {
    return this.allowAgentInitiatedHandoff && rights.canHandoff;
  }

  /** Whether engine policy allows agent-initiated handoff (I3) */
  get agentHandoffEnabled(): boolean {
    return this.allowAgentInitiatedHandoff;
  }

  /** Host switch defaults (preferredOnly enforced in switch) */
  get switchDefaults(): Required<NonNullable<SessionAclConfig['switchDefaults']>> {
    return this.switchConfig;
  }

  private nextGrantSeq(sessionId: string): number {
    const next = (this.grantSeqBySession.get(sessionId) ?? 0) + 1;
    this.grantSeqBySession.set(sessionId, next);
    return next;
  }

  /**
   * Active participants on a session
   *
   * @param session - session data
   * @returns non-revoked participants
   */
  listParticipants(session: SessionData): SessionParticipant[] {
    return (session.participants ?? []).filter((p) => p.revokedAt == null);
  }

  /**
   * Grant role binding (illegal grants rejected at grant time — E6).
   *
   * @param session - session mutated with participant list
   * @param input - agent + role + optional rights override
   * @returns grant result
   */
  grant(
    session: SessionData,
    input: {
      agentId: string;
      roleId: string;
      rights?: SessionRights;
      grantedBy?: string;
      reason?: string;
      agentMax?: SessionRights;
    },
  ): GrantResult {
    const role = this.catalog.get(input.roleId);
    if (!role) {
      return { ok: false, reason: `unknown roleId "${input.roleId}"` };
    }

    const agentMax = input.agentMax ?? {};
    const roleMax = role.max ?? role.defaults;

    // L0: agent path cannot grant canHandoff when engine default forbids it
    const proposedHandoff =
      input.rights?.canHandoff === true ||
      (input.rights?.canHandoff === undefined && role.defaults.canHandoff);
    if (proposedHandoff && (!this.allowAgentInitiatedHandoff || !roleMax.canHandoff)) {
      return {
        ok: false,
        reason: 'canHandoff is host-controlled; factory roles and engine L0 deny agent handoff',
      };
    }

    const candidate = computeEffectiveRights({
      role,
      agentMax,
      participantRights: input.rights,
      allowAgentInitiatedHandoff: this.allowAgentInitiatedHandoff,
    });

    // Illegal grant if candidate tries to exceed role.max ∩ agent.max on any field
    const ceiling = computeEffectiveRights({
      role: { ...role, defaults: roleMax },
      agentMax,
      participantRights: undefined,
      allowAgentInitiatedHandoff: this.allowAgentInitiatedHandoff,
    });
    if (exceedsRightsCeiling(candidate, ceiling) && input.rights) {
      // overlay cannot legally raise above defaults∩max; computeEffective already ANDs
      // but readScope overlay could raise — check explicitly
      if (
        input.rights.readScope &&
        exceedsRightsCeiling(
          {
            ...candidate,
            readScope: input.rights.readScope,
          },
          ceiling,
        )
      ) {
        return { ok: false, reason: 'rights override exceeds role.max / agent.max' };
      }
    }

    if (input.rights?.readScope) {
      const rank: Record<string, number> = { none: 0, summary_tail: 1, from_grant: 2, full: 3 };
      if (rank[input.rights.readScope]! > rank[ceiling.readScope]!) {
        return { ok: false, reason: 'rights override exceeds role.max / agent.max' };
      }
    }
    // boolean 提升不得越过 role.max ∩ agent.max
    const illegalRaise =
      (input.rights?.canRun === true && !ceiling.canRun) ||
      (input.rights?.writeMemory === true && !ceiling.writeMemory) ||
      (input.rights?.canManageTasks === true && !ceiling.canManageTasks);
    if (illegalRaise) {
      return { ok: false, reason: 'rights override exceeds role.max / agent.max' };
    }

    const participant: SessionParticipant = {
      sessionId: session.id,
      agentId: input.agentId,
      roleId: input.roleId,
      rights: input.rights,
      grantedBy: input.grantedBy,
      reason: input.reason,
      grantSeq: this.nextGrantSeq(session.id),
      grantedAt: Date.now(),
    };

    const others = (session.participants ?? []).filter(
      (p) => !(p.agentId === input.agentId && p.revokedAt == null),
    );
    session.participants = [...others, participant];
    return { ok: true, participant };
  }

  /**
   * Revoke active participant binding
   *
   * @param session - session data
   * @param agentId - agent to revoke
   * @returns true if an active binding was revoked
   */
  revoke(session: SessionData, agentId: string): boolean {
    const list = session.participants ?? [];
    let revoked = false;
    session.participants = list.map((p) => {
      if (p.agentId === agentId && p.revokedAt == null) {
        revoked = true;
        return { ...p, revokedAt: Date.now() };
      }
      return p;
    });
    return revoked;
  }

  /**
   * Resolve active participant for agent
   *
   * @param session - session data
   * @param agentId - run target
   * @returns participant or undefined
   */
  resolveParticipant(session: SessionData, agentId: string): SessionParticipant | undefined {
    return this.listParticipants(session).find((p) => p.agentId === agentId);
  }

  /**
   * authorizeRun — L0 ∩ role.max ∩ agent.max ∩ binding
   *
   * Primary without participant: auto-bind owner when catalog has owner (host policy default).
   * Non-primary without participant: deny (I6 structured intent / E6 floor).
   *
   * @param input - session + agent + optional agent ceilings
   * @returns authorization result
   */
  authorizeRun(input: {
    session: SessionData;
    agentId: string;
    agentMax?: SessionRights;
    suggestedSessionRole?: string;
  }): AuthorizeRunResult {
    const { session, agentId } = input;
    let participant = this.resolveParticipant(session, agentId);
    let autoBoundOwner = false;

    if (!participant) {
      const primary = session.primaryAgentId ?? session.agentId;
      if (agentId === primary && this.catalog.has('owner')) {
        const grant = this.grant(session, {
          agentId,
          roleId: 'owner',
          grantedBy: 'system:auto-primary',
          reason: 'primary agent default owner binding',
          agentMax: input.agentMax,
        });
        if (!grant.ok || !grant.participant) {
          return { ok: false, reason: grant.reason ?? 'auto owner bind failed' };
        }
        participant = grant.participant;
        autoBoundOwner = true;
      } else {
        return {
          ok: false,
          reason: `unauthorized run: no participant for agent "${agentId}" on session "${session.id}"`,
        };
      }
    }

    const role = this.catalog.get(participant.roleId);
    if (!role) {
      return { ok: false, reason: `unknown roleId "${participant.roleId}" on participant` };
    }

    const rights = computeEffectiveRights({
      role,
      agentMax: input.agentMax,
      participantRights: participant.rights,
      allowAgentInitiatedHandoff: this.allowAgentInitiatedHandoff,
    });

    if (!rights.canRun) {
      return {
        ok: false,
        reason: `role "${participant.roleId}" denies canRun`,
        roleId: participant.roleId,
        rights,
      };
    }

    return {
      ok: true,
      roleId: participant.roleId,
      rights,
      autoBoundOwner,
    };
  }

  /**
   * Filter Information window by readScope (E6 / I6 exposure).
   *
   * @param session - session data
   * @param rights - effective rights
   * @param participant - optional participant for from_grant seq
   * @returns visible messages
   */
  filterHistory(
    session: SessionData,
    rights: EffectiveSessionRights,
    participant?: SessionParticipant,
  ): Message[] {
    const messages = session.messages ?? [];
    switch (rights.readScope) {
      case 'none':
        return [];
      case 'full':
        return messages;
      case 'from_grant': {
        // 缺 seq/at 时 fail-closed（避免误给全量 Exposure）
        if (!participant || participant.grantSeq == null) {
          return [];
        }
        const at = participant.grantedAt ?? 0;
        return messages.filter((m) => (m.timestamp ?? 0) >= at);
      }
      case 'summary_tail': {
        const tail = messages.slice(-20);
        return tail;
      }
      default:
        return messages;
    }
  }

  /**
   * Session switch (I3): preferred vs handoff
   *
   * - `preferred`: Agency / Activation default executor. Sets
   *   `preferredAgentId` only; **never** changes `primaryAgentId`.
   *   Optionally auto-grants `specialist` when target has no binding.
   * - `handoff`: Accountability transfer. Changes `primaryAgentId`.
   *   Host/control-plane only unless `allowAgentInitiatedHandoff` (default false).
   *
   * All successful switches append Principal audit to `session.switchAudit`.
   *
   * @param session - session mutated in place
   * @param input - mode + target agent + Principal
   * @returns switch result
   */
  switch(
    session: SessionData,
    input: {
      mode: SessionSwitchMode;
      toAgentId: string;
      reason?: string;
      agentMax?: SessionRights;
    } & PrincipalRef,
  ): SwitchSessionResult {
    const defaults = this.switchDefaults;
    const { mode, toAgentId } = input;
    const fromPreferred = session.preferredAgentId;
    const fromPrimary = session.primaryAgentId ?? session.agentId;

    if (!toAgentId?.trim()) {
      return { ok: false, reason: 'toAgentId is required' };
    }

    if (mode === 'handoff') {
      // preferredOnly：产品缺省「切换走 preferred」；handoff 需显式 admin 意图
      if (defaults.preferredOnly && (input.intent ?? 'handoff') !== 'admin_handoff') {
        return {
          ok: false,
          reason: 'sessionAcl.switchDefaults.preferredOnly: handoff requires intent=admin_handoff',
        };
      }
      const isHostPlane =
        input.actorType === 'host' ||
        input.actorType === 'user' ||
        input.actorType === 'service' ||
        input.actorType === 'subsystem' ||
        input.actorType === 'timer';
      const isAgent = input.actorType === 'agent';
      if (isAgent && !this.allowAgentInitiatedHandoff) {
        return {
          ok: false,
          reason: 'handoff is host/control-plane only (I3); agent-initiated handoff is disabled',
        };
      }
      if (!isHostPlane && !isAgent) {
        // missing actorType: require explicit host when requireExplicitHandoff
        if (defaults.requireExplicitHandoff) {
          return {
            ok: false,
            reason: 'handoff requires explicit host/control-plane actor (I6 structured intent)',
          };
        }
      }
    }

    // preferred: grant specialist when no active binding (product default)
    let grantedRoleId: string | undefined;
    if (mode === 'preferred') {
      const existing = this.resolveParticipant(session, toAgentId);
      if (!existing && this.catalog.has(defaults.consultGrantRole)) {
        const grant = this.grant(session, {
          agentId: toAgentId,
          roleId: defaults.consultGrantRole,
          grantedBy: input.actorId ?? 'host:switch_preferred',
          reason: input.reason ?? 'switch_preferred auto-grant',
          agentMax: input.agentMax,
          rights: undefined,
        });
        if (!grant.ok) {
          return { ok: false, reason: grant.reason ?? 'auto-grant specialist failed', mode };
        }
        grantedRoleId = grant.participant?.roleId;
      }
      session.preferredAgentId = toAgentId;
    } else {
      session.primaryAgentId = toAgentId;
      // 不改写 session.agentId（归属投影）；Accountability 只由 handoff 改 primaryAgentId
      // I3：Accountability 迁走后，旧 primary 不再保留 owner 绑定（降级为 specialist）
      if (fromPrimary && fromPrimary !== toAgentId) {
        const oldPrimary = this.resolveParticipant(session, fromPrimary);
        if (oldPrimary && oldPrimary.roleId === 'owner') {
          this.revoke(session, fromPrimary);
          if (this.catalog.has('specialist')) {
            this.grant(session, {
              agentId: fromPrimary,
              roleId: 'specialist',
              grantedBy: input.actorId ?? 'host:handoff',
              reason: input.reason ?? 'demoted from owner after handoff',
              agentMax: input.agentMax,
            });
          }
        }
      }
      const existing = this.resolveParticipant(session, toAgentId);
      if (!existing && this.catalog.has('owner')) {
        const grant = this.grant(session, {
          agentId: toAgentId,
          roleId: 'owner',
          grantedBy: input.actorId ?? 'host:handoff',
          reason: input.reason ?? 'handoff binds new primary as owner',
          agentMax: input.agentMax,
        });
        grantedRoleId = grant.ok ? grant.participant?.roleId : undefined;
      } else if (existing && existing.roleId !== 'owner' && this.catalog.has('owner')) {
        this.revoke(session, toAgentId);
        const grant = this.grant(session, {
          agentId: toAgentId,
          roleId: 'owner',
          grantedBy: input.actorId ?? 'host:handoff',
          reason: input.reason ?? 'handoff promotes primary to owner',
          agentMax: input.agentMax,
        });
        grantedRoleId = grant.ok ? grant.participant?.roleId : undefined;
      }
    }

    const record: SessionSwitchRecord = {
      at: Date.now(),
      mode,
      toAgentId,
      fromPreferredAgentId: fromPreferred,
      fromPrimaryAgentId: fromPrimary,
      toPrimaryAgentId: session.primaryAgentId,
      reason: input.reason,
      actorId: input.actorId,
      actorType: input.actorType,
      tenantId: input.tenantId,
      intent: input.intent ?? (mode === 'preferred' ? 'switch_preferred' : 'handoff'),
    };
    session.switchAudit = [...(session.switchAudit ?? []), record];

    return {
      ok: true,
      mode,
      preferredAgentId: session.preferredAgentId,
      primaryAgentId: session.primaryAgentId,
      grantedRoleId,
    };
  }

  /**
   * Append a Run audit record (I6 Principal fields).
   *
   * @param session - session data
   * @param record - run audit entry
   */
  appendRunAudit(
    session: SessionData,
    record: {
      requestId: string;
      agentId: string;
      actorId?: string;
      actorType?: PrincipalRef['actorType'];
      tenantId?: string;
      intent?: string;
      agentRevision?: string;
    },
  ): void {
    const meta = (session.metadata ??= {});
    const list = Array.isArray(meta.runAudit) ? (meta.runAudit as unknown[]) : [];
    const entry = {
      ...record,
      sessionId: session.id,
      at: Date.now(),
    };
    list.push(entry);
    // keep last 200 to bound memory
    meta.runAudit = list.slice(-200);
  }
}
