/**
 * Phase E — Session ACL / role catalog (constitution E6 / I3)
 *
 * Behavior:
 * 1. Builtin five factory roles (arch/session-acl.md §2)
 * 2. grant rejects unknown role / canHandoff / illegal readScope raise
 * 3. specialist full + writeMemory + canManageTasks; operator minimal
 * 4. authorizeRun: primary auto owner; guest without bind denied
 * 5. effective rights intersection
 */

import { describe, it, expect } from 'vitest';
import { SessionAclService } from '../../src/harness/session-acl/service.js';
import { BUILTIN_SESSION_ROLES } from '../../src/harness/session-acl/seed-roles.js';
import {
  computeEffectiveRights,
  intersectRights,
  exceedsRightsCeiling,
} from '../../src/harness/session-acl/rights.js';
import type { SessionData } from '../../src/harness/session-types.js';

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
    messages: [
      { role: 'user', content: 'old', timestamp: Date.now() - 10_000 },
      { role: 'assistant', content: 'old-reply', timestamp: Date.now() - 9_000, agentId },
      { role: 'user', content: 'new', timestamp: Date.now() },
    ],
    turns: [],
    metadata: {},
  };
}

describe('BUILTIN_SESSION_ROLES (E3)', () => {
  it('ships exactly the five factory roles', () => {
    const ids = BUILTIN_SESSION_ROLES.map((r) => r.id).sort();
    expect(ids).toEqual(['operator', 'owner', 'reviewer', 'specialist', 'steward']);
  });

  it('specialist/reviewer readScope=full; specialist writeMemory+canManageTasks', () => {
    const specialist = BUILTIN_SESSION_ROLES.find((r) => r.id === 'specialist')!;
    const reviewer = BUILTIN_SESSION_ROLES.find((r) => r.id === 'reviewer')!;
    const operator = BUILTIN_SESSION_ROLES.find((r) => r.id === 'operator')!;

    expect(specialist.defaults.readScope).toBe('full');
    expect(specialist.defaults.writeMemory).toBe(true);
    expect(specialist.defaults.canManageTasks).toBe(true);
    expect(specialist.defaults.canHandoff).toBe(false);

    expect(reviewer.defaults.readScope).toBe('full');
    expect(reviewer.defaults.writeMemory).toBe(false);
    expect(reviewer.defaults.canManageTasks).toBe(false);
    expect(reviewer.defaults.canHandoff).toBe(false);

    expect(operator.defaults.readScope).toBe('none');
    expect(operator.defaults.writeMemory).toBe(false);
    expect(operator.defaults.canManageTasks).toBe(false);
    expect(operator.defaults.canHandoff).toBe(false);
  });

  it('factory roles never grant canHandoff', () => {
    for (const role of BUILTIN_SESSION_ROLES) {
      expect(role.defaults.canHandoff).toBe(false);
    }
  });
});

describe('rights math (E6)', () => {
  it('intersect takes stricter readScope', () => {
    const r = intersectRights(
      {
        canRun: true,
        readScope: 'full',
        writeMemory: true,
        canManageTasks: true,
        canHandoff: false,
      },
      {
        canRun: true,
        readScope: 'none',
        writeMemory: false,
        canManageTasks: true,
        canHandoff: false,
      },
    );
    expect(r.readScope).toBe('none');
    expect(r.writeMemory).toBe(false);
  });

  it('exceedsRightsCeiling detects illegal readScope raise', () => {
    const ceiling = {
      canRun: true,
      readScope: 'none' as const,
      writeMemory: false,
      canManageTasks: false,
      canHandoff: false,
    };
    expect(
      exceedsRightsCeiling(
        { ...ceiling, readScope: 'full' },
        ceiling,
      ),
    ).toBe(true);
  });

  it('computeEffectiveRights clamps agent max', () => {
    const role = BUILTIN_SESSION_ROLES.find((r) => r.id === 'specialist')!;
    const effective = computeEffectiveRights({
      role,
      agentMax: { readScope: 'from_grant', writeMemory: false },
    });
    expect(effective.readScope).toBe('from_grant');
    expect(effective.writeMemory).toBe(false);
    expect(effective.canManageTasks).toBe(true);
  });
});

describe('SessionAclService grant / authorizeRun (E6)', () => {
  it('rejects unknown roleId', () => {
    const acl = new SessionAclService();
    const s = session();
    const res = acl.grant(s, { agentId: 'b', roleId: 'consultant' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('unknown roleId');
  });

  it('rejects canHandoff grant even if requested (L0 + factory)', () => {
    const acl = new SessionAclService();
    const s = session();
    const res = acl.grant(s, {
      agentId: 'b',
      roleId: 'specialist',
      rights: { canHandoff: true },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/handoff/i);
  });

  it('rejects readScope override above role max', () => {
    const acl = new SessionAclService({
      roles: [
        {
          id: 'limited',
          defaults: {
            canRun: true,
            readScope: 'none',
            writeMemory: false,
            canManageTasks: false,
            canHandoff: false,
          },
          max: {
            canRun: true,
            readScope: 'none',
            writeMemory: false,
            canManageTasks: false,
            canHandoff: false,
          },
        },
      ],
    });
    const s = session();
    const res = acl.grant(s, {
      agentId: 'b',
      roleId: 'limited',
      rights: { readScope: 'full' },
    });
    expect(res.ok).toBe(false);
  });

  it('specialist full exposure + learning + tasks', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    const grant = acl.grant(s, { agentId: 'spec', roleId: 'specialist' });
    expect(grant.ok).toBe(true);

    const auth = acl.authorizeRun({ session: s, agentId: 'spec' });
    expect(auth.ok).toBe(true);
    expect(auth.roleId).toBe('specialist');
    expect(auth.rights?.readScope).toBe('full');
    expect(auth.rights?.writeMemory).toBe(true);
    expect(auth.rights?.canManageTasks).toBe(true);
    expect(auth.rights?.canHandoff).toBe(false);
  });

  it('operator has minimal exposure and no learning/tasks', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    acl.grant(s, { agentId: 'ops', roleId: 'operator' });
    const auth = acl.authorizeRun({ session: s, agentId: 'ops' });
    expect(auth.ok).toBe(true);
    expect(auth.rights?.readScope).toBe('none');
    expect(auth.rights?.writeMemory).toBe(false);
    expect(auth.rights?.canManageTasks).toBe(false);

    const visible = acl.filterHistory(s, auth.rights!);
    expect(visible).toHaveLength(0);
  });

  it('primary without participant auto-binds owner', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    const auth = acl.authorizeRun({ session: s, agentId: 'owner-agent' });
    expect(auth.ok).toBe(true);
    expect(auth.autoBoundOwner).toBe(true);
    expect(auth.roleId).toBe('owner');
    expect(auth.rights?.canRun).toBe(true);
  });

  it('non-primary without participant is denied', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    const auth = acl.authorizeRun({ session: s, agentId: 'stranger' });
    expect(auth.ok).toBe(false);
    expect(auth.reason).toContain('unauthorized');
  });

  it('revoke removes binding and denies subsequent run', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    acl.grant(s, { agentId: 'b', roleId: 'specialist' });
    expect(acl.authorizeRun({ session: s, agentId: 'b' }).ok).toBe(true);
    expect(acl.revoke(s, 'b')).toBe(true);
    expect(acl.authorizeRun({ session: s, agentId: 'b' }).ok).toBe(false);
  });

  it('reviewer full read but no writeMemory', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    acl.grant(s, { agentId: 'rev', roleId: 'reviewer' });
    const auth = acl.authorizeRun({ session: s, agentId: 'rev' });
    expect(auth.rights?.readScope).toBe('full');
    expect(auth.rights?.writeMemory).toBe(false);
    expect(auth.rights?.canManageTasks).toBe(false);
  });

  it('agent maxSessionRights clamp specialist writeMemory', () => {
    const acl = new SessionAclService();
    const s = session('s1', 'owner-agent');
    acl.grant(s, {
      agentId: 'spec',
      roleId: 'specialist',
      agentMax: { writeMemory: false },
    });
    const auth = acl.authorizeRun({
      session: s,
      agentId: 'spec',
      agentMax: { writeMemory: false },
    });
    expect(auth.rights?.writeMemory).toBe(false);
    expect(auth.rights?.readScope).toBe('full');
  });

  it('allowAgentInitiatedHandoff + custom role can produce canHandoff true (E6 math)', () => {
    const acl = new SessionAclService({
      allowAgentInitiatedHandoff: true,
      switchDefaults: { preferredOnly: false, requireExplicitHandoff: false },
      roles: [
        {
          id: 'handoff-capable',
          defaults: {
            canRun: true,
            readScope: 'full',
            writeMemory: false,
            canManageTasks: false,
            canHandoff: true,
          },
          max: {
            canRun: true,
            readScope: 'full',
            writeMemory: false,
            canManageTasks: false,
            canHandoff: true,
          },
        },
      ],
    });
    const role = acl.catalog.get('handoff-capable')!;
    const effective = computeEffectiveRights({
      role,
      allowAgentInitiatedHandoff: true,
    });
    expect(effective.canHandoff).toBe(true);
  });

  it('factory specialist still has canHandoff false even if engine policy opens', () => {
    const role = BUILTIN_SESSION_ROLES.find((r) => r.id === 'specialist')!;
    const effective = computeEffectiveRights({
      role,
      allowAgentInitiatedHandoff: true,
    });
    expect(effective.canHandoff).toBe(false);
  });
});
