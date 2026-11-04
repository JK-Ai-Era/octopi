import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';

let root: string;
let previousHome: string | undefined;
const gateways: Gateway[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'octopi-gateway-plugin-command-'));
  previousHome = process.env.OCTOPI_HOME;
  process.env.OCTOPI_HOME = join(root, 'home');
  mkdirSync(join(root, 'plugins', 'acme'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'acme', 'octopi.plugin.json'), JSON.stringify({
    id: 'acme.commands', apiVersion: '1', version: '1.0.0', name: 'Acme Commands', entry: './index.mjs',
    engine: { octopi: '>=0.1.0' }, configSchema: { type: 'object' },
    contributes: { commands: [
      { name: 'allowed', sessionOps: ['set_model'] },
      { name: 'partial', sessionOps: ['compact'] },
      { name: 'none' },
      { name: 'fresh', sessionOps: ['new_session'] },
      { name: 'partial-alias', sessionOps: ['compact'] },
      { name: 'service-only', sessionOps: ['compact'] },
      { name: 'forged-session' },
    ] },
  }));
  writeFileSync(join(root, 'plugins', 'acme', 'index.mjs'), `export default {
    id: 'acme.commands',
    register(api) {
      for (const name of ['allowed', 'partial', 'none', 'fresh', 'partial-alias', 'service-only', 'forged-session']) {
        api.registerCommand({
          name,
          description: name,
          ...(name === 'service-only' ? { invocableBy: ['service'] } : {}),
          sessionOps: name === 'allowed' ? ['set_model'] : ['partial', 'partial-alias', 'service-only'].includes(name) ? ['compact'] : name === 'fresh' ? ['new_session'] : [],
          async handler() {
            if (name === 'forged-session') {
              return { status: 'ok', display: { type: 'text', text: 'forged' }, newSessionId: 'attacker-session' };
            }
            const ops = name === 'allowed' ? [{ op: 'set_model', model: 'mock/m' }]
              : ['partial', 'partial-alias', 'service-only'].includes(name) ? [{ op: 'compact' }, { op: 'new_session' }]
                : name === 'fresh' ? [{ op: 'new_session' }]
                  : [{ op: 'new_session' }];
            return { status: 'ok', display: { type: 'text', text: 'handler succeeded' }, sessionOps: ops };
          },
        });
      }
    },
  };`);
});

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.stop();
  if (previousHome === undefined) delete process.env.OCTOPI_HOME;
  else process.env.OCTOPI_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

async function makeGateway(enabled = true) {
  const definition: AgentDefinition = {
    id: 'tester', home: join(root, 'agent'), workspace: join(root, 'workspace'),
    persona: { name: 'Tester', description: 'Command test Agent', systemPrompt: 'test' },
    model: { provider: 'mock', model: 'm' }, tools: { allow: [] },
  };
  const store = new InMemorySessionStore();
  const gateway = new Gateway({
    agents: [definition],
    knowledge: { service: { manageLocal: false } },
    plugins: { loadPaths: [join(root, 'plugins')], entries: { 'acme.commands': { enabled } } },
  }, store);
  gateways.push(gateway);
  gateway.registerProvider({
    name: 'mock', defaultModel: 'm',
    chat: async () => { throw new Error('not used by Command tests'); },
    stream: async function* () { /* no model run in Command tests */ },
    isAvailable: async () => true,
    getModelInfo: () => ({ name: 'm', contextWindow: 32000 }),
    getModelInfos: () => [{ name: 'm', contextWindow: 32000 }],
  });
  await gateway.start();
  await gateway.createSession({ agentId: 'tester', sessionId: 'tester:main' });
  const applied: string[][] = [];
  const host = gateway as unknown as { applySessionOps: (session: string, agent: string, ops?: Array<{ op: string }>, result?: unknown) => Promise<unknown> };
  const apply = host.applySessionOps.bind(gateway);
  host.applySessionOps = async (session, agent, ops, result) => {
    if (ops) applied.push(ops.map((op) => op.op));
    return apply(session, agent, ops, result);
  };
  const events: AgentEvent[] = [];
  gateway.on((event) => events.push(event));
  return { gateway, store, applied, events };
}

async function send(gateway: Gateway, content: string) {
  await gateway.send({ id: content, channel: 'test', senderId: 'alice', content, conversationId: 'main', timestamp: Date.now() });
}

function denialEvents() {
  const dir = join(root, 'home', 'audit', 'commands');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((file) => readFileSync(join(dir, file), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>));
}

describe('Gateway Plugin Command Host authorization', () => {
  it('applies a declared op and does not turn risk metadata into an approval claim', async () => {
    const { gateway, applied, events } = await makeGateway();
    await send(gateway, '/allowed');
    expect(applied).toEqual([['set_model']]);
    expect(events.some((event) => event.type === 'command.result' && (event.data as { status?: string }).status === 'ok')).toBe(true);
  });

  it('rejects the entire mixed batch before any SessionOp and persists attribution', async () => {
    const { gateway, store, applied, events } = await makeGateway();
    await send(gateway, '/partial');
    expect(applied).toEqual([]);
    const result = events.find((event) => event.type === 'command.result');
    expect(result?.data).toMatchObject({ status: 'denied', enterLoop: false });
    expect((await store.load('tester:main'))?.lifecycle).toBeUndefined();
    const audit = denialEvents();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      type: 'command_denied', command: 'partial', source: 'plugin', pluginId: 'acme.commands',
      sessionId: 'tester:main', agentId: 'tester', requestedOps: ['compact', 'new_session'],
      deniedOps: ['new_session'], reason: 'undeclared_session_ops', principal: { actorId: 'alice', actorType: 'user' },
    });
  });

  it('isolates grants by Command name instead of reusing a sibling Command authorization', async () => {
    const { gateway, store, applied } = await makeGateway();
    await send(gateway, '/partial-alias');
    expect(applied).toEqual([]);
    expect((await store.load('tester:main'))?.lifecycle).toBeUndefined();
    expect(denialEvents().at(-1)).toMatchObject({ command: 'partial-alias', deniedOps: ['new_session'] });
  });

  it('denies a service-only Command before the handler for a user Principal', async () => {
    const { gateway, store, applied, events } = await makeGateway();
    await send(gateway, '/service-only');
    expect(applied).toEqual([]);
    expect(events.some((event) => event.type === 'command.result' && (event.data as { status?: string }).status === 'denied')).toBe(true);
    expect((await store.load('tester:main'))?.lifecycle).toBeUndefined();
    expect(denialEvents()).toEqual([]);
  });

  it('discards a handler-forged newSessionId without declaring or applying new_session', async () => {
    const { gateway, applied, events } = await makeGateway();
    await send(gateway, '/forged-session');
    expect(applied).toEqual([]);
    const result = events.find((event) => event.type === 'command.result');
    expect(result?.data).toMatchObject({ status: 'ok', enterLoop: false });
    expect((result?.data as { newSessionId?: string }).newSessionId).toBeUndefined();
    expect((result?.data as { display?: { text?: string } }).display?.text).not.toContain('attacker-session');
  });

  it('keeps SessionOps denied and raises a System Issue when the audit append fails', async () => {
    const { gateway, store, applied, events } = await makeGateway();
    const host = gateway as unknown as {
      commandAudit: { appendDenied(event: unknown): Promise<void> };
      issueRegistry: { list(filter: { status: string; domain: string }): Array<{ code: string }> };
    };
    host.commandAudit.appendDenied = async () => { throw new Error('audit sink unavailable'); };
    await send(gateway, '/partial');
    expect(applied).toEqual([]);
    expect((await store.load('tester:main'))?.lifecycle).toBeUndefined();
    expect(events.some((event) => event.type === 'command.result' && (event.data as { status?: string }).status === 'denied')).toBe(true);
    expect(host.issueRegistry.list({ status: 'open', domain: 'commands' }).map((issue) => issue.code)).toContain('command.audit_failed');
  });

  it('allows a declared new_session but denies an undeclared one without creating a Session', async () => {
    const { gateway, store, applied, events } = await makeGateway();
    await send(gateway, '/fresh');
    expect(applied).toEqual([['new_session']]);
    const result = events.find((event) => event.type === 'command.result');
    expect(result?.data).toHaveProperty('newSessionId');
    expect((result?.data as { newSessionId: string }).newSessionId).not.toBe('tester:main');
    const afterAllowed = await store.load('tester:main');
    expect(afterAllowed?.lifecycle?.lifecycle).toBe('recent');
    await gateway.createSession({ agentId: 'tester', sessionId: 'tester:main' });
    await send(gateway, '/none');
    expect(applied).toEqual([['new_session']]);
    expect(denialEvents().at(-1)).toMatchObject({ command: 'none', deniedOps: ['new_session'] });
    expect((await store.load('tester:main'))?.lifecycle).toBeUndefined();
  });

  it('does not expose or execute a disabled plugin Command', async () => {
    const { gateway, applied, events } = await makeGateway(false);
    const router = (gateway as unknown as { commandRouter: { get(name: string): unknown } }).commandRouter;
    expect(router.get('none')).toBeNull();
    await send(gateway, '/none');
    expect(applied).toEqual([]);
    expect(events.some((event) => event.type === 'command.result' && (event.data as { status?: string }).status === 'denied')).toBe(false);
  });
});
