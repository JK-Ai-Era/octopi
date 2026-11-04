/**
 * 用户 commands/*.md 与 plugin 命令桥接
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadUserCommandDefs } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/commands/user-source.js';
import { pluginCommandsFromManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/commands/plugin-bridge.js';
import { CommandRouter } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/commands/router.js';
import type { SessionReadView } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/commands/types.js';
import type { PluginManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/manager.js';

const view: SessionReadView = { sessionId: 's', agentId: 'a', hasActiveRun: false };

describe('loadUserCommandDefs', () => {
  const dir = resolve('./tests/fixtures/tmp-user-cmds');

  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('加载 prompt 模板命令', async () => {
    writeFileSync(
      resolve(dir, 'review.md'),
      `---\nname: review\ndescription: 审查代码\nkind: prompt\n---\n请审查：\n\n$ARGUMENTS\n`,
    );
    const loaded = loadUserCommandDefs(dir);
    expect(loaded).toHaveLength(1);
    const defs = loaded.map((x) => x.definition);
    expect(loaded[0].ref).toContain('review.md');
    expect(defs[0].name).toBe('review');
    expect(defs[0].source).toBe('user');
    const expanded = await defs[0].expand!({
      sessionId: 's',
      agentId: 'a',
      principal: {},
      args: ['a.ts'],
      raw: '/review a.ts',
      view,
    });
    expect(expanded.messages[0].content).toContain('a.ts');
  });

  test('无 name 跳过', () => {
    writeFileSync(resolve(dir, 'x.md'), `---\ndescription: y\n---\nbody\n`);
    expect(loadUserCommandDefs(dir)).toHaveLength(0);
  });

  test('缺失目录返回空', () => {
    expect(loadUserCommandDefs(resolve('./no-such-cmds'))).toHaveLength(0);
  });
});

describe('pluginCommandsFromManager', () => {
  test('preserves declared metadata and Host-assigned plugin identity', async () => {
    let calls = 0;
    const fakePm = {
      getCommands: () => [{
        pluginId: 'p1',
        name: '/ping',
        description: 'Ping',
        kind: 'prompt',
        risk: 'high',
        invocableBy: ['agent', 'service'],
        args: [{ name: 'target', required: true }],
        preempt: true,
        handler: async () => {
          calls += 1;
          return 'pong';
        },
      }],
    } as unknown as PluginManager;

    const [{ definition, ref }] = pluginCommandsFromManager(fakePm);
    expect(ref).toBe('p1');
    expect(definition).toMatchObject({
      name: 'ping', source: 'plugin', kind: 'prompt', risk: 'high', preempt: true,
      invocableBy: ['agent', 'service'], args: [{ name: 'target', required: true }],
    });

    const router = new CommandRouter();
    expect(router.register(definition, ref).ok).toBe(true);
    expect(router.listCatalog()[0]).toMatchObject({ kind: 'prompt', risk: 'high', preempt: true });

    const userDenied = await router.execute({ content: '/ping target', sessionId: 's', agentId: 'a', view });
    expect(userDenied.kind === 'command' && userDenied.result.status).toBe('denied');
    expect(calls).toBe(0);
    const serviceAllowed = await router.execute({
      content: '/ping target', sessionId: 's', agentId: 'a',
      principal: { actorType: 'service', actorId: 'job-1' }, view,
    });
    expect(serviceAllowed.kind === 'command' && serviceAllowed.result.display.text).toBe('pong');
    expect(calls).toBe(1);
  });

  test('maps host, user and timer to principal without granting service access', async () => {
    const router = new CommandRouter();
    let calls = 0;
    router.register({
      name: 'principal', description: 'Principal', kind: 'control', source: 'user',
      execute: async () => { calls += 1; return { status: 'ok', display: { type: 'text', text: 'ok' } }; },
    });
    router.register({
      name: 'service', description: 'Service', kind: 'control', source: 'user', invocableBy: ['service'],
      execute: async () => { calls += 1; return { status: 'ok', display: { type: 'text', text: 'ok' } }; },
    });
    for (const actorType of ['host', 'user', 'timer'] as const) {
      const principal = { actorType };
      const allowed = await router.execute({ content: '/principal', sessionId: 's', agentId: 'a', principal, view });
      expect(allowed.kind === 'command' && allowed.result.status).toBe('ok');
      const denied = await router.execute({ content: '/service', sessionId: 's', agentId: 'a', principal, view });
      expect(denied.kind === 'command' && denied.result.status).toBe('denied');
    }
    expect(calls).toBe(3);
  });

  test('does not grant principal access to services or subsystems by default', async () => {
    const router = new CommandRouter();
    let calls = 0;
    expect(router.register({
      name: 'private', description: 'Principal only', kind: 'control', source: 'user',
      execute: async () => {
        calls += 1;
        return { status: 'ok', display: { type: 'text', text: 'ok' } };
      },
    }).ok).toBe(true);
    for (const actorType of ['service', 'subsystem'] as const) {
      const out = await router.execute({
        content: '/private', sessionId: 's', agentId: 'a',
        principal: { actorType }, view,
      });
      expect(out.kind === 'command' && out.result.status).toBe('denied');
    }
    expect(calls).toBe(0);
  });
});
