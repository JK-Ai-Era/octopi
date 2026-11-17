/**
 * 防复发守卫：凡 `fork` 本地 node 子进程的模块，必须把选项交给 `forkChildNodeOptions`
 * （`packages/engine/src/fork-child.ts`）——除非在 ALLOW 里登记了理由。
 *
 * 为什么是这条不变量：`windowsHide` 漏写不会让任何测试变红，只会让 Windows 用户
 * 看到一个不消失的控制台窗口（run-serve-child 就这么漏了一整个版本）。两处手抄选项
 * 必然会各自漂移，集中成唯一出口后才谈得上不再复发。
 *
 * 判据（`classifySource`，见下）刻意做窄但**不**做幼稚的字符串包含匹配：
 * - 覆盖 5 种取 `fork` 的写法（命名/默认/命名空间导入、require、动态 import）
 * - 覆盖 `node:child_process` 与 `child_process` 两种曲线
 * - 「用了 helper」判据是**调用**（`forkChildNodeOptions(`），注释里提一句不算
 * - 匹配前去掉注释，避免 docblock 里的示例 import 把文件误判成 fork 站点
 *
 * 这些判据由 `classifySource` 的 inline 样本自测锁住（本文件末尾）——否则守卫自己
 * 漏检时没人知道。绕过必须是**显式决定**（ALLOW 登记 + 理由），不能是静默遗漏；
 * ALLOW 里登记了却已不存在的条目同样报红。
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * 允许不经 helper 的例外（仓库相对路径 → 理由）。
 *
 * - src/cli/commands.ts：fork 的是**守护进程**，且必须 `detached: true`（Windows 下走
 *   `DETACHED_PROCESS`，本就不分配控制台，`windowsHide` 无作用）。它与本 helper 的契约
 *   不同：helper 假定「非 detached + 末位 ipc + 环境清洗」，而这里要的正是脱离本 shell、
 *   单独成一棵进程树，故不能套用（否则会把「为什么 detach」这层语义埋掉）。
 */
const ALLOW = new Map<string, string>([
  ['src/cli/commands.ts', 'detached daemon fork：DETACHED_PROCESS 不分配控制台，需独立进程树'],
]);

/** 去掉行注释与块注释（判据只看代码，不看 docblock 示例） */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 从 child_process 取 `fork` 的所有常见写法（含 `node:` 前缀与无前缀） */
const FORK_PATTERNS: RegExp[] = [
  // import { fork } / import { type X, fork as f } from 'node:child_process'
  /\bimport\s*(?:type\s*)?\{[^}]*\bfork\b[^}]*\}\s*from\s*['"](?:node:)?child_process['"]/,
  // import cp from 'node:child_process'  /  import * as cp from 'node:child_process'
  /\bimport\s+(?:[\w$]+\s*|\*\s*as\s+[\w$]+\s*)from\s*['"](?:node:)?child_process['"]/,
  // const { fork } = require('node:child_process')
  /\b(?:const|let|var)\s*\{[^}]*\bfork\b[^}]*\}\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/,
  // const { fork } = await import('node:child_process')
  /\b(?:const|let|var)\s*\{[^}]*\bfork\b[^}]*\}\s*=\s*await\s+import\(\s*['"](?:node:)?child_process['"]\s*\)/,
];

/** 该源码是否从 child_process 取 fork（含命名空间/默认导入——可能后续 `cp.fork(`） */
export function takesFork(source: string): boolean {
  const code = stripComments(source);
  return FORK_PATTERNS.some((re) => re.test(code));
}

/** 该源码是否真的**调用**了共享 helper（不是只在注释里提名字） */
export function callsHelper(source: string): boolean {
  return /\bforkChildNodeOptions\s*\(/.test(stripComments(source));
}

/** 仓库相对路径（统一 `/` 分隔、无前导分隔符） */
function relOf(file: string): string {
  return relative(repoRoot, file).split(sep).join('/');
}

/** 递归收集 .ts 文件（跳过 dist / node_modules） */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectSources(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** 所有待检根：packages/<pkg>/src + 根 src/ */
function sourceRoots(): string[] {
  const roots: string[] = [];
  const packagesDir = join(repoRoot, 'packages');
  for (const pkg of readdirSync(packagesDir)) {
    const srcDir = join(packagesDir, pkg, 'src');
    if (statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) roots.push(srcDir);
  }
  const cliSrc = join(repoRoot, 'src');
  if (statSync(cliSrc, { throwIfNoEntry: false })?.isDirectory()) roots.push(cliSrc);
  return roots;
}

/** 全仓取 fork 的站点（仓库相对路径） */
function forkSites(): string[] {
  const sites: string[] = [];
  for (const root of sourceRoots()) {
    for (const file of collectSources(root)) {
      if (takesFork(readFileSync(file, 'utf8'))) sites.push(relOf(file));
    }
  }
  return sites;
}

describe('fork 本地 node 子进程必须走共享选项出口', () => {
  it('取 fork 的源文件都必须调用 forkChildNodeOptions（或显式登记例外）', () => {
    const offences = forkSites().filter((rel) => {
      if (ALLOW.has(rel)) return false;
      return !callsHelper(readFileSync(join(repoRoot, rel), 'utf8'));
    });
    expect(offences).toEqual([]);
  });

  it('ALLOW 只登记真实存在的 fork 站点（防历史残留稀释守卫）', () => {
    const sites = new Set(forkSites());
    expect([...ALLOW.keys()].filter((rel) => !sites.has(rel))).toEqual([]);
  });

  it('覆盖到已知的真实站点（守卫本身不能空转）', () => {
    expect(forkSites()).toEqual(
      expect.arrayContaining([
        'packages/engine/src/harness/knowledge/start-service-process.ts',
        'packages/gateway/src/gateway/remote-run-backend.ts',
        'src/cli/commands.ts',
      ]),
    );
  });

  it('helper 自身不取 fork（它只生产选项）', () => {
    const helper = readFileSync(
      join(repoRoot, 'packages', 'engine', 'src', 'fork-child.ts'),
      'utf8',
    );
    expect(takesFork(helper)).toBe(false);
  });
});

describe('守卫判据自测（防止守卫本身漏检）', () => {
  const cases: Array<[string, string, boolean]> = [
    ['命名导入 + node: 前缀', "import { fork } from 'node:child_process';", true],
    ['命名导入 + 无前缀', "import { fork } from 'child_process';", true],
    ['混入其它符号', "import { spawn, fork, type ChildProcess } from 'node:child_process';", true],
    ['默认导入', "import cp from 'node:child_process';", true],
    ['命名空间导入', "import * as cp from 'node:child_process';", true],
    ['require 解构', "const { fork } = require('node:child_process');", true],
    ['动态 import 解构', "const { fork } = await import('node:child_process');", true],
    ['只 import spawn', "import { spawn } from 'node:child_process';", false],
    ['注释里的示例 import', "/*\n * import { fork } from 'node:child_process';\n */\nexport {};", false],
    ['行注释里的示例', "// import { fork } from 'node:child_process'\nexport {};", false],
  ];

  for (const [name, source, expected] of cases) {
    it(`takesFork: ${name} → ${expected}`, () => {
      expect(takesFork(source)).toBe(expected);
    });
  }

  it('callsHelper 只认调用，不认注释里提名字', () => {
    expect(callsHelper('forkChildNodeOptions({ stdio })')).toBe(true);
    expect(callsHelper('// 见 forkChildNodeOptions 的说明\nfoo();')).toBe(false);
    expect(callsHelper('/** 调用 forkChildNodeOptions(...) 获得选项 */\nfoo();')).toBe(false);
  });
});
