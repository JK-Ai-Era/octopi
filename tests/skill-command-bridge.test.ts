/**
 * Skill frontmatter.command → CommandRouter 桥接注册（真实 skills 目录）
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { DefaultSkillManager } from '../src/harness/plugin-ecosystem/skills/manager.js';
import {
  CommandRouter,
  skillCommandsFromManager,
} from '../src/harness/plugin-ecosystem/commands/index.js';
import type { SessionReadView } from '../src/harness/plugin-ecosystem/commands/types.js';

const view: SessionReadView = { sessionId: 's', agentId: 'default', hasActiveRun: false };
const skillsDir = join(homedir(), '.octopi/agents/default/skills');

describe('Skill command bridge（~/.octopi/agents/default/skills）', () => {
  let router: CommandRouter;
  let mgr: DefaultSkillManager;

  beforeAll(async () => {
    mgr = new DefaultSkillManager();
    await mgr.discover(skillsDir);
    router = new CommandRouter();
    // 与 Gateway.registerSkillCommands 同源：ref = skillId
    const defs = skillCommandsFromManager(mgr, (id) => mgr.load(id));
    for (const skill of mgr.list()) {
      if (!skill.command) continue;
      const def = defs.find((d) => d.name === skill.command);
      if (def) {
        const r = router.register(def, `skill:${skill.id}`);
        expect(r.ok).toBe(true);
      }
    }
  });

  test('summarize-text 技能解析 command: summarize', () => {
    expect(existsSync(join(skillsDir, 'summarize-text/SKILL.md'))).toBe(true);
    const skill = mgr.get('summarize-text');
    expect(skill?.command).toBe('summarize');
  });

  test('/summarize 注册进 Router catalog', () => {
    const cat = router.listCatalog();
    const item = cat.find((c) => c.name === 'summarize');
    expect(item).toBeTruthy();
    expect(item?.display).toBe('/summarize');
    expect(item?.kind).toBe('prompt');
    expect(item?.source).toBe('skill');
    expect(item?.description).toContain('Summarize');
  });

  test('/summarize expand 带 $ARGUMENTS 且可进 Loop', async () => {
    const out = await router.execute({
      content: '/summarize octopi is an embeddable agent engine',
      sessionId: 's',
      agentId: 'default',
      view,
    });
    expect(out.kind).toBe('command');
    if (out.kind !== 'command') return;
    expect(out.definition?.source).toBe('skill');
    expect(out.result.enterLoop).toBe(true);
    const text = out.result.messages?.[0]?.content ?? '';
    expect(text).toContain('Summarize text');
    expect(text).toContain('octopi is an embeddable agent engine');
  });

  test('同 skillId 重复注册 upsert，不冲突', () => {
    const skill = mgr.get('summarize-text');
    const defs = skillCommandsFromManager(mgr, async () => 'body $ARGUMENTS');
    const def = defs.find((d) => d.name === 'summarize')!;
    const r = router.register(def, `skill:${skill!.id}`);
    expect(r.ok).toBe(true);
    expect(router.get('summarize')).toBeTruthy();
  });
});
