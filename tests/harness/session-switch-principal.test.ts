/**
 * Phase F — preferred / handoff / Principal (constitution I3 / I6)
 *
 * Behavior:
 * 1. preferredAgentId ≠ primaryAgentId
 * 2. switch(preferred) does not change primary
 * 3. switch(handoff) changes primary + audit; agent-initiated denied by default
 * 4. RunRequest / run audit carry actor/tenant/intent field slots
 */

import { describe, it, expect } from 'vitest';
import { SessionAclService } from '../../src/harness/session-acl/service.js';
import type { SessionData } from '../../src/harness/session-types.js';
import { buildRunRequest } from '../../src/harness/agent-runtime/compiler.js';
import type { RuntimeAgent, Trigger } from '../../src/harness/agent-runtime/types.js';

function session(id = 's1', agentId = 'owner-agent'): SessionData {
  return {
    id,
    agentId,
    primaryAgentId: agentId,
    meta: {
      id,
      agentId,
      channelId: 'web',
      peerId: 'ui',
      status: 'idle',
      createdAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
    turns: [],
    metadata: {},
  };
}

describe('switch preferred vs handoff (I3)', () => {
  it('preferred sets preferredAgentId and leaves primary unchanged', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    const res = acl.switch(s, {
      mode: 'preferred',
      toAgentId: 'spec-agent',
      actorId: 'host-1',
      actorType: 'host',
      intent: 'switch_preferred',
      reason: 'user switch to specialist',
    });
    expect(res.ok).toBe(true);
    expect(s.preferredAgentId).toBe('spec-agent');
    expect(s.primaryAgentId).toBe('owner-agent');
    expect(res.primaryAgentId).toBe('owner-agent');
    expect(res.grantedRoleId).toBe('specialist');
  });

  it('preferred auto-grants specialist when target unbound', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    acl.switch(s, { mode: 'preferred', toAgentId: 'b', actorType: 'host', actorId: 'h' });
    const p = acl.resolveParticipant(s, 'b');
    expect(p?.roleId).toBe('specialist');
  });

  it('handoff changes primary and writes audit; preferred untouched', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    acl.switch(s, { mode: 'preferred', toAgentId: 'spec', actorType: 'host', actorId: 'h' });
    const res = acl.switch(s, {
      mode: 'handoff',
      toAgentId: 'new-owner',
      actorType: 'host',
      actorId: 'admin-1',
      tenantId: 't1',
      intent: 'admin_handoff',
      reason: 'escalation',
    });
    expect(res.ok).toBe(true);
    expect(s.primaryAgentId).toBe('new-owner');
    expect(s.preferredAgentId).toBe('spec');
    expect(s.switchAudit?.length).toBe(2);
    const last = s.switchAudit?.[s.switchAudit.length - 1];
    expect(last?.mode).toBe('handoff');
    expect(last?.actorId).toBe('admin-1');
    expect(last?.tenantId).toBe('t1');
    expect(last?.intent).toBe('admin_handoff');
    expect(last?.fromPrimaryAgentId).toBe('owner-agent');
  });

  it('agent-initiated handoff denied by default (I3)', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    const res = acl.switch(s, {
      mode: 'handoff',
      toAgentId: 'malicious',
      actorType: 'agent',
      actorId: 'guest',
      intent: 'admin_handoff',
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/host|control-plane|agent-initiated/i);
    expect(s.primaryAgentId).toBe('owner-agent');
  });

  it('preferredOnly default rejects handoff without admin_handoff intent', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    const res = acl.switch(s, {
      mode: 'handoff',
      toAgentId: 'b',
      actorType: 'host',
      actorId: 'h',
      intent: 'switch_preferred',
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('preferredOnly');
  });

  it('handoff without actorType rejected when requireExplicitHandoff', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    const res = acl.switch(s, { mode: 'handoff', toAgentId: 'b' });
    expect(res.ok).toBe(false);
  });

  it('handoff binds new primary as owner participant', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    acl.switch(s, {
      mode: 'handoff',
      toAgentId: 'new-owner',
      actorType: 'host',
      actorId: 'h',
      intent: 'admin_handoff',
    });
    const auth = acl.authorizeRun({ session: s, agentId: 'new-owner' });
    expect(auth.ok).toBe(true);
    expect(auth.roleId).toBe('owner');
  });

  it('handoff demotes old primary from owner to specialist; agentId unchanged', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    // 先让 old primary 有 owner 绑定
    expect(acl.authorizeRun({ session: s, agentId: 'owner-agent' }).ok).toBe(true);
    acl.switch(s, {
      mode: 'handoff',
      toAgentId: 'new-owner',
      actorType: 'host',
      actorId: 'admin',
      intent: 'admin_handoff',
    });
    expect(s.agentId).toBe('owner-agent');
    expect(s.primaryAgentId).toBe('new-owner');
    const old = acl.resolveParticipant(s, 'owner-agent');
    expect(old?.roleId).toBe('specialist');
    const neu = acl.resolveParticipant(s, 'new-owner');
    expect(neu?.roleId).toBe('owner');
    // specialist 仍可 run（Agency），但不是 primary
    const authOld = acl.authorizeRun({ session: s, agentId: 'owner-agent' });
    expect(authOld.ok).toBe(true);
    expect(authOld.roleId).toBe('specialist');
  });

  it('from_grant fail-closed without participant seq', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    const rights = {
      canRun: true,
      readScope: 'from_grant' as const,
      writeMemory: false,
      canManageTasks: false,
      canHandoff: false,
    };
    expect(acl.filterHistory(s, rights, undefined)).toHaveLength(0);
  });

  it('overlay can raise defaults toward role max', () => {
    const acl = new SessionAclService({
      roles: [
        {
          id: 'raised',
          defaults: {
            canRun: false,
            readScope: 'none',
            writeMemory: false,
            canManageTasks: false,
            canHandoff: false,
          },
          max: {
            canRun: true,
            readScope: 'full',
            writeMemory: false,
            canManageTasks: false,
            canHandoff: false,
          },
        },
      ],
    });
    const s = session('s1', 'owner-agent');
    const grant = acl.grant(s, {
      agentId: 'b',
      roleId: 'raised',
      rights: { canRun: true, readScope: 'full' },
    });
    expect(grant.ok).toBe(true);
    const auth = acl.authorizeRun({ session: s, agentId: 'b' });
    expect(auth.ok).toBe(true);
    expect(auth.rights?.canRun).toBe(true);
    expect(auth.rights?.readScope).toBe('full');
  });
});

describe('Principal field slots on RunRequest (I6)', () => {
  it('buildRunRequest carries actor/tenant/intent when provided', () => {
    const agent: RuntimeAgent = {
      agentId: 'a1',
      dispatcher: {
         
        execute: () => (async function* () {})() as any,
      },
    };
    const trigger: Trigger = {
      id: 't1',
      type: 'message',
      agentId: 'a1',
      sessionId: 's1',
      payload: { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
    } as Trigger;

    const req = buildRunRequest(agent, [trigger], 's1', {
      actorId: 'user-9',
      actorType: 'user',
      tenantId: 'acme',
      intent: 'run',
    });
    expect(req.actorId).toBe('user-9');
    expect(req.actorType).toBe('user');
    expect(req.tenantId).toBe('acme');
    expect(req.intent).toBe('run');
  });
});

describe('run audit Principal fields (I6)', () => {
  it('appendRunAudit stores Principal slots on session.metadata', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'a1');
    acl.appendRunAudit(s, {
      requestId: 'r1',
      agentId: 'a1',
      actorId: 'svc-1',
      actorType: 'service',
      tenantId: 't1',
      intent: 'run',
    });
    const audit = s.metadata.runAudit as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe('svc-1');
    expect(audit[0]?.tenantId).toBe('t1');
    expect(audit[0]?.sessionId).toBe('s1');
  });
});
