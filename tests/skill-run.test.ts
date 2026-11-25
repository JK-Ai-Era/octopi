/**
 * skill_run 执行面 — 解释器三级解析 + 二次 containment + 审查锚定 + 执行
 * （arch/skill-creation-design.md §12.4）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DefaultSkillManager } from '../packages/engine/src/harness/extension/plugin-ecosystem/skills/manager.js';
import { createSkillTools } from '../packages/engine/src/harness/extension/plugin-ecosystem/tools/skill-tools.js';
import type { RegisteredTool } from '../packages/core/src/core/types/tools.js';
import type { SkillLifecycle } from '../packages/engine/src/harness/extension/plugin-ecosystem/skills/lifecycle.js';

let dir: string;
let workspace: string;

function writeSkill(id: string, frontExtra: string, files: Record<string, string>): void {
  const d = join(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'SKILL.md'),
    `---\nname: ${id}\ndescription: Test skill ${id}\n${frontExtra}---\nBody`,
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(d, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

function runTool(manager: DefaultSkillManager): RegisteredTool {
  const tools = createSkillTools({ lifecycle: {} as SkillLifecycle, skills: manager });
  return tools.find((t) => t.definition.name === 'skill_run')!;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'skill-run-'));
  workspace = mkdtempSync(join(tmpdir(), 'skill-run-ws-'));
  // shebang：#!/usr/bin/env bash
  writeSkill('shebanged', '', {
    'scripts/echo.sh': '#!/usr/bin/env bash\necho "shebang-ok:$1"\n',
  });
  // metadata.interpreter 声明 + 无 shebang 的 .txt 脚本
  writeSkill('declared', 'metadata:\n  interpreter: bash\n', {
    'scripts/tool.txt': 'echo "declared-ok"\n',
  });
  // 扩展名映射兜底（.sh → bash），无 shebang
  writeSkill('mapped', '', {
    'scripts/plain.sh': 'echo "mapped-ok"\n',
  });
  // 无任何解释器线索
  writeSkill('noint', '', {
    'scripts/mystery.unknownext': 'echo hi\n',
  });
  // 带输出的脚本（验证 args 透传与输出）
  writeSkill('args', '', {
    'scripts/args.sh': '#!/bin/bash\necho "arg:$1"\n',
  });
  // 漂移用（配合 loadGuard）
  writeSkill('drifty', '', {
    'scripts/x.sh': '#!/bin/bash\ntrue\n',
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe('skill_run 解释器三级解析', () => {
  it('shebang 最优先（#!/usr/bin/env bash → bash）', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const tool = runTool(mgr);
    const result = (await tool.handler!(
      { id: 'shebanged', script: 'scripts/echo.sh', args: ['hello'] },
      ({ cwd: workspace }) as never,
    )) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).toContain('shebang-ok:hello');
    expect(result.interpreter).toBe('bash');
  });

  it('metadata.interpreter 次之（无 shebang 时生效）', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const tool = runTool(mgr);
    const result = (await tool.handler!(
      { id: 'declared', script: 'scripts/tool.txt' },
      ({ cwd: workspace }) as never,
    )) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).toContain('declared-ok');
    expect(result.interpreter).toBe('bash');
  });

  it('扩展名映射兜底（.sh → bash）', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const tool = runTool(mgr);
    const result = (await tool.handler!(
      { id: 'mapped', script: 'scripts/plain.sh' },
      ({ cwd: workspace }) as never,
    )) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).toContain('mapped-ok');
    expect(result.interpreter).toBe('bash');
  });

  it('三级都解析不到 → fail loud（不猜不降级）', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const tool = runTool(mgr);
    await expect(
      tool.handler!({ id: 'noint', script: 'scripts/mystery.unknownext' }, ({ cwd: workspace }) as never),
    ).rejects.toThrow('cannot determine interpreter');
  });
});

describe('skill_run 边界（containment / 锚定 / 报因）', () => {
  it('拒绝脚本路径逃逸（..）', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const tool = runTool(mgr);
    await expect(
      tool.handler!({ id: 'args', script: '../shebanged/scripts/echo.sh' }, ({ cwd: workspace }) as never),
    ).rejects.toThrow('forbidden script path');
  });

  it('拒绝 symlink 逃逸', async () => {
    const link = join(dir, 'args', 'evil.sh');
    try {
      symlinkSync(join(dir, 'shebanged', 'scripts', 'echo.sh'), link);
    } catch {
      return; // 平台不支持 symlink 时跳过
    }
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const tool = runTool(mgr);
    await expect(
      tool.handler!({ id: 'args', script: 'evil.sh' }, ({ cwd: workspace }) as never),
    ).rejects.toThrow('forbidden script path');
  });

  it('审查哈希锚定：漂移拒执行', async () => {
    const mgr = new DefaultSkillManager(dir, {
      loadGuard: {
        checkLoad: () => ({
          allow: false,
          reason: 'content changed since review (hash drift) — resubmit via skill_submit for review',
        }),
      },
    });
    await mgr.discover(dir);
    const tool = runTool(mgr);
    await expect(
      tool.handler!({ id: 'drifty', script: 'scripts/x.sh' }, ({ cwd: workspace }) as never),
    ).rejects.toThrow('hash drift');
  });

  it('不在索引的技能报明确因', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const tool = runTool(mgr);
    await expect(
      tool.handler!({ id: 'ghost', script: 'scripts/x.sh' }, ({ cwd: workspace }) as never),
    ).rejects.toThrow('not found');
  });

  it('脚本不存在报明确因', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const tool = runTool(mgr);
    await expect(
      tool.handler!({ id: 'args', script: 'scripts/ghost.sh' }, ({ cwd: workspace }) as never),
    ).rejects.toThrow('not found in skill');
  });

  it('args 非字符串数组 fail loud', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const tool = runTool(mgr);
    await expect(
      tool.handler!({ id: 'args', script: 'scripts/args.sh', args: [42] }, ({ cwd: workspace }) as never),
    ).rejects.toThrow('array of strings');
  });

  it('args 含空格/引号/& 原样透传（argv 数组形态无注入面）', async () => {
    writeSkill('inject', '', {
      'scripts/echoargs.sh': '#!/bin/bash\nfor a in "$@"; do printf "[%s]" "$a"; done\n',
    });
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const tool = runTool(mgr);
    const result = (await tool.handler!(
      { id: 'inject', script: 'scripts/echoargs.sh', args: ['a b', 'c&d', 'e"f'] },
      ({ cwd: workspace }) as never,
    )) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).toBe('[a b][c&d][e"f]');
  });

  it('.bat/.cmd 拒执行（CVE-2024-27980 立场）', async () => {
    writeSkill('batch', '', { 'scripts/run.bat': '@echo off\r\n' });
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const tool = runTool(mgr);
    await expect(
      tool.handler!({ id: 'batch', script: 'scripts/run.bat' }, ({ cwd: workspace }) as never),
    ).rejects.toThrow('not supported');
  });

  it('ops 审计留痕（tool:skill_run + origin 标注）', async () => {
    const mgr = new DefaultSkillManager(dir);
    await mgr.discover(dir);
    const tool = runTool(mgr);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    await tool.handler!(
      { id: 'args', script: 'scripts/args.sh', args: ['x'] },
      {
        cwd: workspace,
        recordOpsEvent: (r: { event: string; data: Record<string, unknown> }) => events.push(r),
      } as never,
    );
    expect(events.length).toBe(1);
    expect(events[0]!.event).toBe('ops.command.executed');
    expect(events[0]!.data.tool).toBe('skill_run');
    expect(String(events[0]!.data.origin)).toContain('skill:args');
  });

  it('manager 未就绪 fail-loud', async () => {
    const tool = runTool(new DefaultSkillManager(dir));
    const tools = createSkillTools({ lifecycle: {} as SkillLifecycle, skills: () => undefined });
    const lazy = tools.find((t) => t.definition.name === 'skill_run')!;
    await expect(
      lazy.handler!({ id: 'args', script: 'scripts/args.sh' }, ({ cwd: workspace }) as never),
    ).rejects.toThrow('not ready');
    expect(tool).toBeDefined();
  });
});
