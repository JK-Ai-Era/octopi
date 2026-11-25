import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BUILTIN_AGENT_ROLE_PRESETS } from '@octopi-agent/engine/config-admin/agent-presets.js';
import { findBuiltinSkillsDir } from '../src/init.js';

describe('skill review delegation (P4)', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'skill-review-agent-'));
    savedHome = process.env.OCTOPI_HOME;
    process.env.OCTOPI_HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.OCTOPI_HOME;
    else process.env.OCTOPI_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  test('reviewer preset 的 review-checklist 套装与 packaged 技能同源（防漂移）', () => {
    const preset = BUILTIN_AGENT_ROLE_PRESETS.find((p) => p.id === 'reviewer');
    expect(preset).toBeDefined();
    const bundle = preset!.skills?.find((s) => s.id === 'review-checklist');
    expect(bundle).toBeDefined();

    // 打包源定位用 findBuiltinSkillsDir（与 seed 同源），不依赖 cwd（P2-2 假失败防线）
    const skillsDir = findBuiltinSkillsDir();
    expect(skillsDir).not.toBeNull();
    const raw = readFileSync(join(skillsDir!, 'review-checklist', 'SKILL.md'), 'utf-8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    const desc = fm![1].match(/^description:\s*"(.*)"\s*$/m)![1];
    // 正文 + description 都必须同源（人审标准 = 机器审标准）
    expect(bundle!.content.trim()).toBe(body);
    expect(bundle!.description).toBe(desc);
  });

  test('checklist 缺失 → review() 抛错 → llm-gated 退化 human（协议无内联兜底）', async () => {
    const { createSkillLlmReviewer } = await import(
      '@octopi-agent/gateway/gateway/skill-lifecycle-host.js'
    );
    // OCTOPI_HOME 是空目录：shared skills 层无 review-checklist
    const reviewer = createSkillLlmReviewer({
      resolveModel: () => {
        throw new Error('must not be reached — protocol check comes first');
      },
    });
    await expect(
      reviewer.review({ skillId: 'x', skillMd: '---\nname: x\ndescription: d\n---\nbody', files: [], issues: [] }),
    ).rejects.toThrow(/review-checklist/);
  });

  test('协议存在但无委托模型 → review() 抛错（fail-closed 转人工，不自审）', async () => {
    const { createSkillLlmReviewer } = await import(
      '@octopi-agent/gateway/gateway/skill-lifecycle-host.js'
    );
    // 预置 checklist（模拟 seeded shared 层）
    const skillDir = join(home, 'skills', 'review-checklist');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: "review-checklist"\ndescription: "d"\n---\n\n# Review Checklist\n\nBody.',
      'utf-8',
    );
    const reviewer = createSkillLlmReviewer({ resolveModel: () => null });
    await expect(
      reviewer.review({ skillId: 'x', skillMd: '---\nname: x\ndescription: d\n---\nbody', files: [], issues: [] }),
    ).rejects.toThrow(/reviewer/);
  });

  test('委托解析守卫：自指拒绝 / 目标缺失 null / 正常委托（P1-2）', async () => {
    const { resolveReviewDelegation } = await import(
      '@octopi-agent/gateway/gateway/skill-lifecycle-host.js'
    );
    const warn = () => undefined;
    const provider = { chat: async () => ({ content: '' }) } as never;
    const providers = new Map([['p', provider]]);
    const agents = new Map([
      ['self', { skillReviewAgent: 'self', model: { provider: 'p', model: 'm' } }],
      ['ok', { skillReviewAgent: 'rev', model: { provider: 'p', model: 'm' } }],
      ['rev', { model: { provider: 'p', model: 'm2' } }],
      ['ghost', { skillReviewAgent: 'missing', model: { provider: 'p', model: 'm' } }],
      ['none', { model: { provider: 'p', model: 'm' } }],
    ]);
    // 自指 = 恢复自审，必须拒绝
    expect(resolveReviewDelegation('self', agents, providers, warn)).toBeNull();
    // 委托目标不存在
    expect(resolveReviewDelegation('ghost', agents, providers, warn)).toBeNull();
    // 无委托声明
    expect(resolveReviewDelegation('none', agents, providers, warn)).toBeNull();
    // 正常委托：用独立 reviewer 的模型
    expect(resolveReviewDelegation('ok', agents, providers, warn)?.model).toBe('m2');
  });
});
