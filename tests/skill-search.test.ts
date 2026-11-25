/**
 * S2 消费面检索：skill_list / skill_search + search-matchers 共享语义
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSkillManager } from '../packages/engine/src/harness/extension/plugin-ecosystem/skills/manager.js';
import type { SkillLifecycle } from '../packages/engine/src/harness/extension/plugin-ecosystem/skills/lifecycle.js';
import {
  createSkillConsumptionTools,
} from '../packages/engine/src/harness/extension/plugin-ecosystem/tools/skill-tools.js';
import { compileContentMatchers, lineMatches } from '../packages/engine/src/harness/extension/plugin-ecosystem/tools/search-matchers.js';
import type { RegisteredTool } from '../packages/core/src/core/types/index.js';

function pick(tools: RegisteredTool[], name: string): RegisteredTool {
  const t = tools.find((x) => x.definition.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

const fakeLifecycle = {} as SkillLifecycle;

function toolsFor(mgr: DefaultSkillManager): RegisteredTool[] {
  return createSkillConsumptionTools(mgr);
}

describe('skill_list / skill_search（S2 检索面）', () => {
  let dir: string;
  let mgr: DefaultSkillManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skill-search-'));
    const abs = (p: string) => resolve(dir, p);
    mkdirSync(abs('alpha/scripts'), { recursive: true });
    mkdirSync(abs('alpha/references'), { recursive: true });
    mkdirSync(abs('alpha/assets'), { recursive: true });
    writeFileSync(
      abs('alpha/SKILL.md'),
      '---\nname: alpha\ndescription: Test skill\n---\nBody mentions needle here.\n',
    );
    writeFileSync(abs('alpha/scripts/run.sh'), 'echo needle-in-script\necho other\n');
    writeFileSync(abs('alpha/references/spec.md'), 'spec line needle\nspec line 2\nspec line 3\n');
    writeFileSync(abs('alpha/assets/logo.bin'), Buffer.from([0x89, 0x00, 0x01, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
    mgr = new DefaultSkillManager(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('skill_list', () => {
    it('列条目不带提要（比 skill_read 清单更轻）', async () => {
      await mgr.discover(dir);
      const tool = pick(toolsFor(mgr), 'skill_list');
      const r = (await tool.handler!({ id: 'alpha' }, undefined as never)) as Record<string, unknown>;
      const files = r.files as Array<Record<string, unknown>>;
      expect(files.map((f) => f.path).sort()).toEqual([
        'assets/logo.bin',
        'references/spec.md',
        'scripts/run.sh',
      ]);
      for (const f of files) {
        expect(f).not.toHaveProperty('excerpt');
        expect(typeof f.bytes).toBe('number');
      }
      // SKILL.md 不列（正文面已给）
      expect(files.some((f) => f.path === 'SKILL.md')).toBe(false);
    });

    it('subdir 过滤', async () => {
      await mgr.discover(dir);
      const tool = pick(toolsFor(mgr), 'skill_list');
      const r = (await tool.handler!({ id: 'alpha', subdir: 'references' }, undefined as never)) as Record<
        string,
        unknown
      >;
      const files = r.files as Array<{ path: string }>;
      expect(files.map((f) => f.path)).toEqual(['references/spec.md']);
    });

    it('pattern glob 过滤', async () => {
      await mgr.discover(dir);
      const tool = pick(toolsFor(mgr), 'skill_list');
      const r = (await tool.handler!({ id: 'alpha', pattern: '**/*.md' }, undefined as never)) as Record<
        string,
        unknown
      >;
      const files = r.files as Array<{ path: string }>;
      expect(files.map((f) => f.path).sort()).toEqual(['references/spec.md']);
    });

    it('不存在的技能报因', async () => {
      await mgr.discover(dir);
      const tool = pick(toolsFor(mgr), 'skill_list');
      await expect(tool.handler!({ id: 'ghost' }, undefined as never)).rejects.toThrow('not found');
    });
  });

  describe('skill_search', () => {
    it('命中带 file:line，二进制跳过', async () => {
      await mgr.discover(dir);
      const tool = pick(toolsFor(mgr), 'skill_search');
      const r = (await tool.handler!({ id: 'alpha', pattern: 'needle' }, undefined as never)) as Record<
        string,
        unknown
      >;
      const matches = r.matches as Array<{ file: string; line: number }>;
      const files = matches.map((m) => m.file).sort();
      // assets/logo.bin 含 'needle' 字节但二进制跳过；SKILL.md 也在快照里被搜到
      expect(files).toContain('scripts/run.sh');
      expect(files).toContain('references/spec.md');
      expect(files).not.toContain('assets/logo.bin');
      const scriptHit = matches.find((m) => m.file === 'scripts/run.sh');
      expect(scriptHit!.line).toBe(1);
    });

    it('与 file_search 同源语义：auto 模式字面搜（正则特殊字符不误编译）', async () => {
      writeFileSync(resolve(dir, 'alpha/scripts/literal.txt'), 'arr[0] is here\n');
      await mgr.discover(dir);
      const tool = pick(toolsFor(mgr), 'skill_search');
      const r = (await tool.handler!({ id: 'alpha', pattern: 'arr[0]' }, undefined as never)) as Record<
        string,
        unknown
      >;
      const matches = r.matches as Array<{ file: string }>;
      expect(matches.map((m) => m.file)).toContain('scripts/literal.txt');
    });

    it('glob 过滤 + context_lines + max_results 截断', async () => {
      await mgr.discover(dir);
      const tool = pick(toolsFor(mgr), 'skill_search');
      const r = (await tool.handler!(
        { id: 'alpha', pattern: 'spec line', glob: 'references/**', context_lines: 1, max_results: 2 },
        undefined as never,
      )) as Record<string, unknown>;
      const matches = r.matches as Array<{ file: string; before?: string[]; after?: string[] }>;
      expect(matches).toHaveLength(2);
      expect(r.truncated).toBe(true);
      expect(matches.every((m) => m.file === 'references/spec.md')).toBe(true);
      expect(matches[0]!.after?.[0]).toBe('spec line 2');
    });

    it('漂移拒搜（快照锚定同源）', async () => {
      const guarded = new DefaultSkillManager(dir, {
        loadGuard: {
          checkLoad: () => ({
            allow: false,
            kind: 'hash_drift' as const,
            reason: 'content changed since review (hash drift)',
          }),
        },
      });
      await guarded.discover(dir);
      const tool = pick(toolsFor(guarded), 'skill_search');
      await expect(
        tool.handler!({ id: 'alpha', pattern: 'needle' }, undefined as never),
      ).rejects.toThrow('hash drift');
    });

    it('pattern 必填（空白词条过滤——空串会匹配一切）', async () => {
      await mgr.discover(dir);
      const tool = pick(toolsFor(mgr), 'skill_search');
      await expect(tool.handler!({ id: 'alpha' }, undefined as never)).rejects.toThrow('Provide pattern');
      await expect(
        tool.handler!({ id: 'alpha', pattern: '  ' }, undefined as never),
      ).rejects.toThrow('Provide pattern');
      await expect(
        tool.handler!({ id: 'alpha', patterns: ['', '   '] }, undefined as never),
      ).rejects.toThrow('Provide pattern');
    });

    it('恰好满额不误报 truncated（满额后仍有更多才截断）', async () => {
      // spec.md 恰好 3 处 "spec line"（尾空行不含）
      await mgr.discover(dir);
      const tool = pick(toolsFor(mgr), 'skill_search');
      const exact = (await tool.handler!(
        { id: 'alpha', pattern: 'spec line', max_results: 3 },
        undefined as never,
      )) as Record<string, unknown>;
      expect((exact.matches as unknown[]).length).toBe(3);
      expect(exact.truncated).toBe(false);
      const cut = (await tool.handler!(
        { id: 'alpha', pattern: 'spec line', max_results: 2 },
        undefined as never,
      )) as Record<string, unknown>;
      expect(cut.truncated).toBe(true);
    });

    it('SKILL.md 搜索坐标 = skill_read 正文坐标（续读不偏移）', async () => {
      await mgr.discover(dir);
      const tool = pick(toolsFor(mgr), 'skill_search');
      const r = (await tool.handler!(
        { id: 'alpha', pattern: 'Body mentions', glob: 'SKILL.md' },
        undefined as never,
      )) as Record<string, unknown>;
      const matches = r.matches as Array<{ file: string; line: number }>;
      expect(matches).toHaveLength(1);
      // 正文第 1 行 = 'Body mentions needle here.'（frontmatter 剥壳后坐标）
      expect(matches[0]!.line).toBe(1);
    });

    it('skill_list 拒绝语义升格 throw（drift 不降级为空清单）', async () => {
      const guarded = new DefaultSkillManager(dir, {
        loadGuard: {
          checkLoad: () => ({
            allow: false,
            kind: 'hash_drift' as const,
            reason: 'content changed since review (hash drift)',
          }),
        },
      });
      await guarded.discover(dir);
      const tool = pick(toolsFor(guarded), 'skill_list');
      await expect(tool.handler!({ id: 'alpha' }, undefined as never)).rejects.toThrow('hash drift');
    });
  });
});

describe('search-matchers 共享语义（file_search / skill_search 同源）', () => {
  it('auto：代码字面量保持 literal', () => {
    const m = compileContentMatchers(['arr[0]', 'useState()', 'C++'], 'auto', true);
    expect(m.mode).toBe('literal');
    expect(lineMatches('x = arr[0] + y', m.matchers)).toBe(true);
    expect(lineMatches('literal arrX0Y not matched', m.matchers)).toBe(false);
  });

  it('auto：a|b 是分支字面 OR', () => {
    const m = compileContentMatchers(['foo()|a+b'], 'auto', true);
    expect(lineMatches('call foo() now', m.matchers)).toBe(true);
    expect(lineMatches('c = a+b', m.matchers)).toBe(true);
    // 分支转义：`.` 是字面点
    expect(lineMatches('fooX not matched', m.matchers)).toBe(false);
  });

  it('regex 模式显式编译，非法模式抛', () => {
    const m = compileContentMatchers(['^needle$'], 'regex', true);
    expect(m.mode).toBe('regex');
    expect(lineMatches('needle', m.matchers)).toBe(true);
    expect(lineMatches('x needle', m.matchers)).toBe(false);
    expect(() => compileContentMatchers(['[unclosed'], 'regex', true)).toThrow('Invalid pattern');
  });

  it('大小写敏感开关', () => {
    const ci = compileContentMatchers(['Needle'], 'auto', false);
    expect(lineMatches('needle', ci.matchers)).toBe(true);
    const cs = compileContentMatchers(['Needle'], 'auto', true);
    expect(lineMatches('needle', cs.matchers)).toBe(false);
  });
});

describe('S4 失配标注：requiredTools 与可用工具差集', () => {
  it('缺工具标注 missing-tools；齐了/未传 availableTools 不标注', async () => {
    const { renderSkillIndexEntries } = await import(
      '../packages/engine/src/harness/extension/plugin-ecosystem/skills/index-render.js'
    );
    const entries = [
      { id: 'a', name: 'a', description: 'D', filePath: '/x/a/SKILL.md', requiredTools: ['shell', 'web_search'] },
      { id: 'b', name: 'b', description: 'D', filePath: '/x/b/SKILL.md', requiredTools: ['shell'] },
    ];
    const partial = renderSkillIndexEntries(entries, { availableTools: ['shell', 'file_read'] });
    expect(partial).toContain('<missing-tools>web_search</missing-tools>');
    expect(partial).not.toContain('shell</missing-tools>');
    const full = renderSkillIndexEntries(entries, { availableTools: ['shell', 'web_search'] });
    expect(full).not.toContain('missing-tools');
    const noTools = renderSkillIndexEntries(entries);
    expect(noTools).not.toContain('missing-tools');
  });
});
