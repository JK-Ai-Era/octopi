/**
 * 用户 commands/*.md 与 plugin 命令桥接
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadUserCommandDefs } from '../src/harness/plugin-ecosystem/commands/user-source.js';
import { pluginCommandsFromManager } from '../src/harness/plugin-ecosystem/commands/plugin-bridge.js';
import { CommandRouter } from '../src/harness/plugin-ecosystem/commands/router.js';
import type { SessionReadView } from '../src/harness/plugin-ecosystem/commands/types.js';
import type { PluginManager } from '../src/harness/plugin-ecosystem/plugins/manager.js';

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
  test('包装 registerCommand handler', async () => {
    const fakePm = {
      getCommands: () => [
        {
          pluginId: 'p1',
          name: '/ping',
          description: 'Ping',
          handler: async () => 'pong',
        },
      ],
    } as unknown as PluginManager;

    const defs = pluginCommandsFromManager(fakePm);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('ping');
    expect(defs[0].source).toBe('plugin');

    const router = new CommandRouter();
    expect(router.register(defs[0], 'plugin:p1').ok).toBe(true);

    const out = await router.execute({
      content: '/ping',
      sessionId: 's',
      agentId: 'a',
      view,
    });
    expect(out.kind).toBe('command');
    if (out.kind === 'command') {
      expect(out.result.display.text).toBe('pong');
    }
  });
});
