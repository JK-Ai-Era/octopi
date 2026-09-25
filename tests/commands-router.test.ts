/**
 * CommandRouter / parse / 冲突策略 / skill 桥接
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  CommandRouter,
  parseCommand,
  normalizeCommandName,
  unescapeLiteralSlash,
  createBuiltinCommands,
  createClientCatalogCommand,
  skillCommandsFromManager,
} from '../src/harness/plugin-ecosystem/commands/index.js';
import type { CommandDefinition, SessionReadView } from '../src/harness/plugin-ecosystem/commands/types.js';
import { IssueRegistry } from '../src/harness/diagnostics/registry.js';
import { DefaultSkillManager } from '../src/harness/plugin-ecosystem/skills/manager.js';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const view = (over: Partial<SessionReadView> = {}): SessionReadView => ({
  sessionId: 's1',
  agentId: 'a1',
  hasActiveRun: false,
  ...over,
});

function cmd(partial: Partial<CommandDefinition> & { name: string }): CommandDefinition {
  return {
    description: partial.description ?? partial.name,
    kind: 'control',
    source: 'user',
    execute: async () => ({ status: 'ok', display: { type: 'text', text: 'ok' } }),
    ...partial,
  };
}

describe('parseCommand', () => {
  test('解析 /name args', () => {
    const p = parseCommand('/review src/foo.ts --strict');
    expect(p).toEqual({ name: 'review', args: ['src/foo.ts', '--strict'], raw: '/review src/foo.ts --strict' });
  });

  test('非命令返回 null', () => {
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('  /')).toBeNull();
  });

  test('// 转义不是命令', () => {
    expect(parseCommand('//path/to/file')).toBeNull();
    expect(unescapeLiteralSlash('//path/to/file')).toBe('/path/to/file');
  });

  test('normalize 去斜杠与小写', () => {
    expect(normalizeCommandName('/Review')).toBe('review');
    expect(normalizeCommandName('bad name')).toBeNull();
  });
});

describe('CommandRouter 注册与冲突', () => {
  let issues: IssueRegistry;
  let router: CommandRouter;

  beforeEach(() => {
    issues = new IssueRegistry();
    router = new CommandRouter({ issueRegistry: issues });
  });

  test('builtin 占用保留名，skill 同名被拒', () => {
    expect(router.register(cmd({ name: 'stop', source: 'builtin' })).ok).toBe(true);
    const r = router.register(cmd({ name: 'stop', source: 'skill' }));
    expect(r.ok).toBe(false);
    expect(router.get('stop')?.source).toBe('builtin');
    const open = issues.list({ status: 'open', domain: 'commands' });
    expect(open.length).toBeGreaterThan(0);
    expect(open[0].code).toBe('command.reserved_denied');
  });

  test('同源重复：不同 ref 双方皆拒（粘性）', () => {
    expect(router.register(cmd({ name: 'pdf', source: 'skill', description: 'a' }), 'skill:a').ok).toBe(true);
    const r = router.register(cmd({ name: 'pdf', source: 'skill', description: 'b' }), 'skill:b');
    expect(r.ok).toBe(false);
    expect(router.get('pdf')).toBeNull();
    // 第三方再注册仍拒绝（粘性，不独苗成功）
    const r2 = router.register(cmd({ name: 'pdf', source: 'skill', description: 'c' }), 'skill:c');
    expect(r2.ok).toBe(false);
    expect(router.get('pdf')).toBeNull();
  });

  test('同 (source, ref) 重复注册 = upsert', () => {
    expect(router.register(cmd({ name: 'pdf', source: 'skill', description: 'v1' }), 'skill:a').ok).toBe(true);
    const r = router.register(cmd({ name: 'pdf', source: 'skill', description: 'v2' }), 'skill:a');
    expect(r.ok).toBe(true);
    expect(router.get('pdf')?.description).toBe('v2');
  });

  test('跨源同名 reject-all 双方皆拒', () => {
    expect(router.register(cmd({ name: 'review', source: 'user' }), 'user:review.md').ok).toBe(true);
    const r = router.register(cmd({ name: 'review', source: 'skill' }), 'skill:code-review');
    expect(r.ok).toBe(false);
    expect(router.get('review')).toBeNull();
  });

  test('reject-all 不会清掉 builtin 保留命令', () => {
    expect(router.register(cmd({ name: 'model', source: 'builtin' }), 'builtin').ok).toBe(true);
    const r = router.register(cmd({ name: 'model', source: 'skill' }), 'skill:shadow');
    // 保留名直接拒绝，builtin 仍在
    expect(r.ok).toBe(false);
    expect(router.get('model')?.source).toBe('builtin');
  });

  test('唯一注册进 catalog', () => {
    router.register(cmd({ name: 'review', source: 'user' }));
    const cat = router.listCatalog();
    expect(cat.some((c) => c.name === 'review')).toBe(true);
    expect(cat.find((c) => c.name === 'review')?.display).toBe('/review');
  });

  test('resolve 后 issue 可消失（改名场景由重新注册触发）', () => {
    router.register(cmd({ name: 'pdf', source: 'skill' }), 'a');
    router.register(cmd({ name: 'pdf', source: 'skill' }), 'b');
    const id = `commands:command.conflict:pdf`;
    expect(issues.get(id)?.status).toBe('open');
    issues.resolve(id);
    expect(issues.get(id)?.status).toBe('resolved');
  });
});

describe('CommandRouter execute', () => {
  test('未知命令 error', async () => {
    const router = new CommandRouter();
    const out = await router.execute({
      content: '/nope',
      sessionId: 's',
      agentId: 'a',
      view: view(),
    });
    expect(out.kind).toBe('command');
    if (out.kind === 'command') {
      expect(out.result.status).toBe('error');
    }
  });

  test('非命令 content 经 // 转义', async () => {
    const router = new CommandRouter();
    const out = await router.execute({
      content: '//etc/passwd',
      sessionId: 's',
      agentId: 'a',
      view: view(),
    });
    expect(out).toEqual({ kind: 'not_command', content: '/etc/passwd' });
  });

  test('/stop 返回 abort_run sessionOps', async () => {
    const issues = new IssueRegistry();
    const router = new CommandRouter({ issueRegistry: issues });
    const host = {
      hasActiveRun: () => true,
      currentModel: () => 'm',
      listModels: () => [{ id: 'p/m' }],
      listIssues: () => [],
      listCatalogNames: () => [],
    };
    for (const def of createBuiltinCommands(host)) {
      router.register(def, 'builtin');
    }
    const out = await router.execute({
      content: '/stop',
      sessionId: 's',
      agentId: 'a',
      view: view({ hasActiveRun: true }),
    });
    expect(out.kind).toBe('command');
    if (out.kind === 'command') {
      expect(out.definition?.preempt).toBe(true);
      expect(out.result.sessionOps?.[0]).toEqual({ op: 'abort_run', reason: 'user_stop' });
      expect(out.result.display.text).toContain('已停止');
    }
  });

  test('prompt expand 进 Loop', async () => {
    const router = new CommandRouter();
    router.register(
      cmd({
        name: 'review',
        source: 'skill',
        kind: 'prompt',
        expand: async (ctx) => ({
          messages: [{ role: 'user', content: `review ${ctx.args[0]}` }],
        }),
        execute: async () => ({ status: 'ok', display: { type: 'text', text: 'x' } }),
      }),
    );
    const out = await router.execute({
      content: '/review foo.ts',
      sessionId: 's',
      agentId: 'a',
      view: view(),
    });
    expect(out.kind).toBe('command');
    if (out.kind === 'command') {
      expect(out.result.enterLoop).toBe(true);
      expect(out.result.messages?.[0]?.content).toBe('review foo.ts');
    }
  });

  test('Run 在途：非 preempt 命令拒绝，/stop 可执行', async () => {
    const router = new CommandRouter();
    const host = {
      hasActiveRun: () => true,
      currentModel: () => 'm',
      listModels: () => [{ id: 'p/m' }],
      listIssues: () => [],
      listCatalogNames: () => [],
    };
    for (const def of createBuiltinCommands(host)) {
      router.register(def, 'builtin');
    }
    const busy = await router.execute({
      content: '/model',
      sessionId: 's',
      agentId: 'a',
      view: view({ hasActiveRun: true }),
    });
    expect(busy.kind).toBe('command');
    if (busy.kind === 'command') {
      expect(busy.result.status).toBe('error');
      expect(busy.result.display.text).toContain('/stop');
      expect(busy.result.sessionOps).toBeUndefined();
    }
    const stop = await router.execute({
      content: '/stop',
      sessionId: 's',
      agentId: 'a',
      view: view({ hasActiveRun: true }),
    });
    expect(stop.kind).toBe('command');
    if (stop.kind === 'command') {
      expect(stop.definition?.preempt).toBe(true);
      expect(stop.result.sessionOps?.[0]?.op).toBe('abort_run');
    }
  });

  test('client catalog 命令可注册', async () => {
    const router = new CommandRouter();
    router.register(createClientCatalogCommand(), 'builtin:client');
    expect(router.get('clear')?.kind).toBe('client');
  });
});

describe('Skill frontmatter.command', () => {
  const dir = resolve('./tests/fixtures/tmp-skill-cmd');

  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('解析 command 字段并桥接 expand', async () => {
    mkdirSync(resolve(dir, 'pdf-reader'), { recursive: true });
    writeFileSync(
      resolve(dir, 'pdf-reader/SKILL.md'),
      `---\nname: pdf-reader\ndescription: Read PDF\ncommand: /Pdf\n---\nRead it.\n\n## Arguments\n$ARGUMENTS\n`,
    );
    const mgr = new DefaultSkillManager();
    await mgr.discover(dir);
    const skill = mgr.get('pdf-reader');
    expect(skill?.command).toBe('pdf');

    const defs = skillCommandsFromManager(mgr, async () => 'Read it.\n\n## Arguments\n$ARGUMENTS\n');
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('pdf');
    expect(defs[0].kind).toBe('prompt');

    const expanded = await defs[0].expand!({
      sessionId: 's',
      agentId: 'a',
      principal: {},
      args: ['a.pdf'],
      raw: '/pdf a.pdf',
      view: view(),
    });
    expect(expanded.messages[0].content).toContain('a.pdf');
  });

  test('无 command 字段不注册', async () => {
    mkdirSync(resolve(dir, 'plain'), { recursive: true });
    writeFileSync(
      resolve(dir, 'plain/SKILL.md'),
      `---\nname: plain\ndescription: No cmd\n---\nbody\n`,
    );
    const mgr = new DefaultSkillManager();
    await mgr.discover(dir);
    expect(mgr.get('plain')?.command).toBeUndefined();
    expect(skillCommandsFromManager(mgr, async () => null)).toHaveLength(0);
  });

  test('非法 command 不透出', async () => {
    mkdirSync(resolve(dir, 'bad'), { recursive: true });
    writeFileSync(
      resolve(dir, 'bad/SKILL.md'),
      `---\nname: bad\ndescription: x\ncommand: BAD NAME\n---\nbody\n`,
    );
    const mgr = new DefaultSkillManager();
    await mgr.discover(dir);
    expect(mgr.get('bad')?.command).toBeUndefined();
  });
});
