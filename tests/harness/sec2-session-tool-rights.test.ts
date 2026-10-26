/**
 * SEC-2 — SessionRights per-tool: ToolRights algebra + grant clamp + run-time gate.
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeToolRights,
  intersectToolRights,
  toolRightsExceeds,
  isToolAllowedByRights,
  isToolPermitted,
} from '@octopi-agent/engine/harness/governance/session-acl/tool-rights.js';
import {
  computeEffectiveRights,
  exceedsRightsCeiling,
  intersectRights,
} from '@octopi-agent/engine/harness/governance/session-acl/rights.js';
import { SessionAclService } from '@octopi-agent/engine/harness/governance/session-acl/service.js';
import { BUILTIN_SESSION_ROLES } from '@octopi-agent/engine/harness/governance/session-acl/seed-roles.js';
import type { EffectiveSessionRights } from '@octopi-agent/engine/harness/governance/session-acl/types.js';
import type { SessionData as SessionStoreData } from '@octopi-agent/engine/harness/session/types.js';

function session(id = 's1', agentId = 'owner-agent'): SessionStoreData {
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
    tasks: [],
  };
}

function full(): EffectiveSessionRights {
  return {
    canRun: true,
    readScope: 'full',
    writeMemory: true,
    canManageTasks: true,
    canHandoff: false,
    toolRights: { allow: undefined, deny: [], denyCapabilities: [] },
  };
}

describe('ToolRights algebra (SEC-2)', () => {
  it('normalize treats empty input allow as unrestricted and dedupes', () => {
    const r = normalizeToolRights({ allow: [], deny: ['shell', 'shell'], denyCapabilities: ['egress', 'egress'] });
    expect(r.allow).toBeUndefined();
    expect(r.deny).toEqual(['shell']);
    expect(r.denyCapabilities).toEqual(['egress']);
  });

  it('intersect disjoint allowlists yields deny-all (not unrestricted)', () => {
    const r = intersectToolRights({ allow: ['shell'] }, { allow: ['file_read'] });
    expect(r.allow).toEqual([]);
    expect(isToolAllowedByRights('file_read', ['fs-read'], r)).toBe(false);
    expect(isToolAllowedByRights('shell', ['exec'], r)).toBe(false);
  });

  it('intersect handles * wildcard against a concrete allowlist', () => {
    expect(intersectToolRights({ allow: ['*'] }, { allow: ['file_read'] }).allow).toEqual(['file_read']);
    expect(intersectToolRights({ allow: ['*'] }, { allow: ['*'] }).allow).toEqual(['*']);
    expect(intersectToolRights(undefined, { allow: ['file_read'] }).allow).toEqual(['file_read']);
  });

  it('toolRightsExceeds: concrete allowlist under ceiling * is legal', () => {
    expect(toolRightsExceeds({ allow: ['file_read'] }, { allow: ['*'] })).toBe(false);
    expect(toolRightsExceeds({ allow: ['file_read'] }, { allow: ['*', 'other'] })).toBe(false);
    expect(toolRightsExceeds({ allow: ['*'] }, { allow: ['file_read'] })).toBe(true);
    expect(toolRightsExceeds({ allow: ['*'] }, { allow: ['*'] })).toBe(false);
  });

  it('intersect unions deny and intersects allow', () => {
    const r = intersectToolRights(
      { allow: ['file_read', 'file_write', 'shell'], deny: ['http_request'] },
      { allow: ['file_write', 'shell'], deny: ['shell'], denyCapabilities: ['egress'] },
    );
    expect(r.allow).toEqual(['file_write', 'shell']);
    expect(r.deny.sort()).toEqual(['http_request', 'shell']);
    expect(r.denyCapabilities).toEqual(['egress']);
  });

  it('intersect with unrestricted layer keeps the restriction', () => {
    const r = intersectToolRights(undefined, { deny: ['shell'] });
    expect(r.deny).toEqual(['shell']);
    expect(r.allow).toBeUndefined();
  });

  it('toolRightsExceeds: missing ceiling deny is illegal when value is unrestricted', () => {
    expect(toolRightsExceeds({ deny: [] }, { deny: ['shell'] })).toBe(true);
    expect(toolRightsExceeds({ deny: ['shell'] }, { deny: ['shell'] })).toBe(false);
    expect(toolRightsExceeds({ deny: ['shell', 'http_request'] }, { deny: ['shell'] })).toBe(false);
  });

  it('toolRightsExceeds: narrow allowlist need not restate ceiling denies', () => {
    expect(
      toolRightsExceeds(
        { allow: ['file_read'] },
        { deny: ['shell'], denyCapabilities: ['egress'] },
      ),
    ).toBe(false);
    expect(toolRightsExceeds({ allow: ['shell'] }, { deny: ['shell'] })).toBe(true);
  });

  it('toolRightsExceeds: wider allow than ceiling is illegal', () => {
    expect(toolRightsExceeds({ allow: ['file_read', 'shell'] }, { allow: ['file_read'] })).toBe(true);
    expect(toolRightsExceeds({ allow: ['file_read'] }, { allow: ['file_read'] })).toBe(false);
    expect(toolRightsExceeds(undefined, { allow: ['file_read'] })).toBe(true);
    expect(toolRightsExceeds({ allow: [] }, { allow: ['file_read'] })).toBe(false);
  });

  it('toolRightsExceeds: missing ceiling capability deny is illegal when unrestricted', () => {
    expect(toolRightsExceeds({}, { denyCapabilities: ['egress'] })).toBe(true);
    expect(toolRightsExceeds({ denyCapabilities: ['egress'] }, { denyCapabilities: ['egress'] })).toBe(false);
  });

  it('isToolAllowedByRights: deny name, deny capability, allowlist, deny-all', () => {
    expect(isToolAllowedByRights('shell', ['exec'], { deny: ['shell'] })).toBe(false);
    expect(isToolAllowedByRights('http_request', ['egress'], { denyCapabilities: ['egress'] })).toBe(false);
    expect(isToolAllowedByRights('shell', ['exec'], { allow: ['file_read'] })).toBe(false);
    expect(isToolAllowedByRights('file_read', ['fs-read'], { allow: ['file_read'] })).toBe(true);
    expect(isToolAllowedByRights('file_read', ['fs-read'], undefined)).toBe(true);
    expect(isToolAllowedByRights('file_read', ['fs-read'], { allow: [] })).toBe(false);
  });

  it('denyCapabilities fail-closed on unknown/un-tagged tools', () => {
    // resolveToolCapabilities returns null for untagged third-party names
    expect(isToolAllowedByRights('mystery_tool', null, { denyCapabilities: ['exec'] })).toBe(false);
    expect(isToolAllowedByRights('mystery_tool', null, { deny: [] })).toBe(true);
  });

  it('isToolPermitted requires every layer (agent policy ∩ session rights)', () => {
    const agent = { deny: ['shell'] };
    const sessionRights = { deny: ['http_request'], denyCapabilities: [] };
    expect(isToolPermitted('shell', ['exec'], [agent, sessionRights])).toBe(false);
    expect(isToolPermitted('http_request', ['egress'], [agent, sessionRights])).toBe(false);
    expect(isToolPermitted('file_read', ['fs-read'], [agent, sessionRights])).toBe(true);
  });
});

describe('E6 rights math with toolRights', () => {
  it('intersectRights narrows tool surface', () => {
    const a = { ...full(), toolRights: { allow: ['file_read', 'shell'], deny: [] } };
    const b = { ...full(), toolRights: { deny: ['shell'], denyCapabilities: ['egress'] } };
    const r = intersectRights(a, b);
    expect(r.toolRights.allow).toEqual(['file_read', 'shell']);
    expect(r.toolRights.deny).toEqual(['shell']);
    expect(r.toolRights.denyCapabilities).toEqual(['egress']);
  });

  it('computeEffectiveRights clamps toolRights via L0 ∩ role.max ∩ agent.max', () => {
    const owner = BUILTIN_SESSION_ROLES.find((r) => r.id === 'owner')!;
    const effective = computeEffectiveRights({
      role: {
        ...owner,
        max: { ...owner.defaults, toolRights: { deny: ['shell'], denyCapabilities: ['egress'] } },
      },
      agentMax: { toolRights: { deny: ['http_request'] } },
      participantRights: { toolRights: { deny: ['file_delete'] } },
      allowAgentInitiatedHandoff: false,
    });
    expect(effective.toolRights.deny?.sort()).toEqual(['file_delete', 'http_request', 'shell']);
    expect(effective.toolRights.denyCapabilities).toEqual(['egress']);
  });

  it('exceedsRightsCeiling flags toolRights expansion', () => {
    const ceiling = { ...full(), toolRights: { deny: ['shell'], denyCapabilities: ['egress'] } };
    const ok = { ...full(), toolRights: { deny: ['shell', 'http_request'], denyCapabilities: ['egress'] } };
    const bad = { ...full(), toolRights: { deny: [], denyCapabilities: [] } };
    expect(exceedsRightsCeiling(ok, ceiling)).toBe(false);
    expect(exceedsRightsCeiling(bad, ceiling)).toBe(true);
  });

  it('overlay toolRights intersect defaults (narrow-only, never expands)', () => {
    const owner = BUILTIN_SESSION_ROLES.find((r) => r.id === 'owner')!;
    const effective = computeEffectiveRights({
      role: {
        ...owner,
        defaults: {
          ...owner.defaults,
          toolRights: { deny: ['shell'], denyCapabilities: ['exec'] },
        },
      },
      // overlay tries to clear the deny — must be ignored (intersect)
      participantRights: { toolRights: { deny: [] } },
      allowAgentInitiatedHandoff: false,
    });
    expect(effective.toolRights.deny).toEqual(['shell']);
    expect(effective.toolRights.denyCapabilities).toEqual(['exec']);
  });
});

describe('grant clamps toolRights (E6 illegal raise)', () => {
  it('rejects overlay that re-allows a ceiling-denied tool', () => {
    const acl = new SessionAclService({
      roles: [
        {
          id: 'guest',
          defaults: {
            canRun: true,
            readScope: 'full',
            writeMemory: false,
            canManageTasks: false,
            canHandoff: false,
            toolRights: { deny: ['shell'], denyCapabilities: ['exec'] },
          },
          max: {
            canRun: true,
            readScope: 'full',
            writeMemory: false,
            canManageTasks: false,
            canHandoff: false,
            toolRights: { deny: ['shell'], denyCapabilities: ['exec'] },
          },
        },
      ],
    });
    const s = session();
    const bad = acl.grant(s, {
      agentId: 'guest-1',
      roleId: 'guest',
      rights: { toolRights: { deny: [] } },
    });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/exceeds role\.max/);

    const good = acl.grant(s, {
      agentId: 'guest-2',
      roleId: 'guest',
      rights: { toolRights: { deny: ['shell', 'http_request'], denyCapabilities: ['exec', 'egress'] } },
    });
    expect(good.ok).toBe(true);

    // Narrow allowlist is legal even if it omits ceiling denials
    const readonly = acl.grant(s, {
      agentId: 'guest-3',
      roleId: 'guest',
      rights: { toolRights: { allow: ['file_read', 'file_list'] } },
    });
    expect(readonly.ok).toBe(true);
  });

  it('authorizeRun returns effective toolRights for participant', () => {
    const acl = new SessionAclService({
      roles: [
        {
          id: 'readonly',
          defaults: {
            canRun: true,
            readScope: 'full',
            writeMemory: false,
            canManageTasks: false,
            canHandoff: false,
            toolRights: { deny: ['shell', 'file_write', 'file_delete'], denyCapabilities: ['exec', 'egress'] },
          },
        },
      ],
    });
    const s = session();
    const grant = acl.grant(s, { agentId: 'auditor', roleId: 'readonly' });
    expect(grant.ok).toBe(true);
    const auth = acl.authorizeRun({ session: s, agentId: 'auditor' });
    expect(auth.ok).toBe(true);
    expect(auth.rights?.toolRights.deny).toContain('shell');
    expect(auth.rights?.toolRights.denyCapabilities).toContain('exec');
  });
});

describe('deny: [ * ] semantics', () => {
  it('deny: [ * ] denies every tool name', () => {
    expect(isToolAllowedByRights('file_read', ['fs-read'], { deny: ['*'] })).toBe(false);
    expect(isToolAllowedByRights('shell', ['exec'], { deny: ['*'] })).toBe(false);
    expect(isToolPermitted('file_read', ['fs-read'], [{ deny: ['*'] }])).toBe(false);
    expect(toolRightsExceeds({ deny: ['*'] }, { deny: ['shell'] })).toBe(false);
    expect(toolRightsExceeds({}, { deny: ['*'] })).toBe(true);
    expect(toolRightsExceeds({ allow: ['file_read'] }, { deny: ['*'] })).toBe(true);
    expect(toolRightsExceeds({ deny: ['*'] }, { deny: ['*'] })).toBe(false);
    expect(toolRightsExceeds({ allow: [] }, { deny: ['*'] })).toBe(false);
  });
});

describe('run-time gate (beforeToolCall) and concurrent sessions', () => {
  function stubToolRuntime(sessionToolRights?: Record<string, unknown>) {
    return {
      sessionId: 's',
      agentId: 'a',
      messages: [],
      fileEffects: {
        writeFile: async () => {},
        appendFile: async () => {},
        recordDelete: async () => {},
        recordCreate: async () => {},
        recordRename: async () => {},
        recordOverwrite: async () => {},
        noteNotReversed: async () => {},
      },
      memoryEffects: {
        recordInsert: async () => {},
        recordUpdate: async () => {},
        recordDelete: async () => {},
      },
      sessionToolRights,
    } as never;
  }

  function providerCalling(name: string, callId: string) {
    let calls = 0;
    return {
      name: 'test',
      defaultModel: 'test',
      getModelInfo: () => null,
      async chat() {
        calls += 1;
        if (calls === 1) {
          return {
            content: '',
            toolCalls: [{ id: callId, name, arguments: {} }],
            usage: { promptTokens: 1, completionTokens: 1 },
            model: 'test',
            finishReason: 'tool_calls',
          };
        }
        return {
          content: 'done',
          toolCalls: undefined,
          usage: { promptTokens: 1, completionTokens: 1 },
          model: 'test',
          finishReason: 'stop',
        };
      },
      async *stream() {
        calls += 1;
        if (calls === 1) {
          yield { type: 'tool_call' as const, toolCall: { id: callId, name, arguments: '{}', index: 0 } };
        } else {
          yield { type: 'content' as const, content: 'done' };
        }
        yield { type: 'done' as const, usage: { promptTokens: 1, completionTokens: 1 } };
      },
      async isAvailable() {
        return true;
      },
    };
  }

  it('beforeToolCall blocks denied tools with tool_rights_denied', async () => {
    const { Agent } = await import('@octopi-agent/engine/harness/run/agent/agent.js');
    const { runAgentWithReliability } = await import(
      '@octopi-agent/engine/harness/run/reliability/run-agent.js'
    );
    const { withRunScope } = await import('@octopi-agent/engine/harness/run/run-scope.js');

    let executed = 0;
    const agent = new Agent({
      model: providerCalling('shell', 'c1') as never,
      systemPrompt: 'x',
      tools: [
        {
          name: 'shell',
          description: 'run',
          parameters: { type: 'object' as const, properties: {} },
          execute: async () => {
            executed += 1;
            return { toolCallId: 'c1', name: 'shell', content: 'ran' };
          },
        },
      ],
    });
    agent.context.messages = [{ role: 'user', content: 'go', timestamp: Date.now() }];

    const harness = {
      config: {
        planningRetry: { maxAttempts: 0, steerInstruction: '' },
        emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
        noopThreshold: 99,
        loopDetection: { enabled: false },
      },
    };

    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const gen = runAgentWithReliability(
      agent.context,
      { model: agent.model },
      harness as never,
    );
    for await (const e of withRunScope(
      {
        sessionId: 's-deny',
        agentId: 'a',
        toolRuntime: stubToolRuntime({ deny: ['shell'] }),
      },
      gen,
    )) {
      events.push(e as { type: string; data?: Record<string, unknown> });
    }

    expect(executed).toBe(0);
    const blocked = events.find((e) => e.type === 'security_blocked');
    expect(blocked).toBeTruthy();
    expect(String(blocked?.data?.reason ?? '')).toContain('tool_rights_denied');
  });

  it('priv_exec 被 deny → 确认闸门之前拒绝（not_authorized 留痕，无弹窗）', async () => {
    const { Agent } = await import('@octopi-agent/engine/harness/run/agent/agent.js');
    const { runAgentWithReliability } = await import(
      '@octopi-agent/engine/harness/run/reliability/run-agent.js'
    );
    const { withRunScope } = await import('@octopi-agent/engine/harness/run/run-scope.js');

    let executed = 0;
    let confirmAsks = 0;
    const opsRecords: Array<{ event: string; data: Record<string, unknown> }> = [];
    const agent = new Agent({
      model: providerCalling('priv_exec', 'c-priv') as never,
      systemPrompt: 'x',
      tools: [
        {
          name: 'priv_exec',
          description: 'privileged',
          parameters: { type: 'object' as const, properties: {} },
          execute: async () => {
            executed += 1;
            return { toolCallId: 'c-priv', name: 'priv_exec', content: 'ran' };
          },
        },
      ],
    });
    agent.context.messages = [{ role: 'user', content: 'go', timestamp: Date.now() }];

    const harness = {
      config: {
        planningRetry: { maxAttempts: 0, steerInstruction: '' },
        emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
        noopThreshold: 99,
        loopDetection: { enabled: false },
      },
    };

    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const gen = runAgentWithReliability(
      agent.context,
      { model: agent.model },
      harness as never,
    );
    const toolRuntime = {
      ...(stubToolRuntime({ deny: ['priv_exec'] }) as Record<string, unknown>),
      sessionParticipants: [{ agentId: 'guest-1', roleId: 'guest' }],
      confirmEffect: async () => {
        confirmAsks += 1;
        return 'approve';
      },
      recordOpsEvent: (r: { event: string; data: Record<string, unknown> }) => opsRecords.push(r),
    } as never;
    for await (const e of withRunScope(
      {
        sessionId: 's-priv-deny',
        agentId: 'a',
        toolRuntime,
      },
      gen,
    )) {
      events.push(e as { type: string; data?: Record<string, unknown> });
    }

    // §8.6：缺权参与者连确认闸都到不了——handler 未跑、确认从未询问
    expect(executed).toBe(0);
    expect(confirmAsks).toBe(0);
    expect(events.some((e) => e.type === 'security_blocked')).toBe(true);
    const denied = opsRecords.find(
      (r) => r.event === 'ops.escalation.denied' && r.data.why === 'not_authorized',
    );
    expect(denied).toBeTruthy();
    // 参与者身份入账（ops P5）：谁被拒、什么角色绑定
    expect(denied?.data.origin).toMatchObject({
      sessionId: 's-priv-deny',
      participants: [{ agentId: 'guest-1', roleId: 'guest' }],
    });
  });

  it('concurrent sessions keep independent toolRights (no harness bleed)', async () => {
    const { Agent } = await import('@octopi-agent/engine/harness/run/agent/agent.js');
    const { runAgentWithReliability } = await import(
      '@octopi-agent/engine/harness/run/reliability/run-agent.js'
    );
    const { withRunScope } = await import('@octopi-agent/engine/harness/run/run-scope.js');

    const executions = { deny: 0, allow: 0 };

    const makeAgent = (counterKey: 'deny' | 'allow') => {
      const agent = new Agent({
        model: providerCalling('shell', `c-${counterKey}`) as never,
        systemPrompt: 'x',
        tools: [
          {
            name: 'shell',
            description: 'run',
            parameters: { type: 'object' as const, properties: {} },
            execute: async () => {
              executions[counterKey] += 1;
              return { toolCallId: `c-${counterKey}`, name: 'shell', content: 'ran' };
            },
          },
        ],
      });
      agent.context.messages = [{ role: 'user', content: 'go', timestamp: Date.now() }];
      return agent;
    };

    const harness = {
      config: {
        planningRetry: { maxAttempts: 0, steerInstruction: '' },
        emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
        noopThreshold: 99,
        loopDetection: { enabled: false },
      },
    };

    const consume = async (
      scopeToolRights: Record<string, unknown> | undefined,
      counterKey: 'deny' | 'allow',
    ) => {
      const agent = makeAgent(counterKey);
      const gen = runAgentWithReliability(
        agent.context,
        { model: agent.model },
        harness as never,
      );
      for await (const _e of withRunScope(
        {
          sessionId: `s-${counterKey}`,
          agentId: 'a',
          toolRuntime: stubToolRuntime(scopeToolRights),
        },
        gen,
      )) {
        // drain
      }
    };

    await Promise.all([
      consume({ deny: ['shell'] }, 'deny'),
      consume(undefined, 'allow'),
    ]);

    expect(executions.deny).toBe(0);
    expect(executions.allow).toBe(1);
  });
});
