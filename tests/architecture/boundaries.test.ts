/**
 * Architecture boundary tests
 *
 * Enforces dependency direction:
 * - packages/core/src/core  → no harness / integration / loop / cli / subsystems
 * - packages/core/src/loop  → no harness / integration
 * - packages/engine/src/harness → no integration / gateway / cli / web
 * - packages/gateway/src → no cli / suite init
 *
 * These rules are also mirrored in eslint.config.js (no-restricted-imports).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const CORE_SRC = fileURLToPath(new URL('../../packages/core/src', import.meta.url));
const ENGINE_SRC = fileURLToPath(new URL('../../packages/engine/src', import.meta.url));
const GATEWAY_SRC = fileURLToPath(new URL('../../packages/gateway/src', import.meta.url));

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Extract relative import specifiers from a TS source file.
 *
 * 门禁边界：覆盖静态 `from '…'` 与字面量 `import('…')` / `import type('…')`。
 * **不**覆盖 `require('…')`、模板串或变量 `import(x)`——那些应靠 code review。
 * ESLint `no-restricted-imports` 对动态 `import()` 覆盖有限，故以本测试为准。
 */
function extractImports(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s+['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      specs.push(m[1]);
    }
  }
  return specs;
}

function forbiddenTargets(spec: string): string[] {
  // Only relative imports can leave a layer; package imports are checked separately.
  if (!spec.startsWith('.')) return [];
  const hit: string[] = [];
  for (const layer of ['harness', 'integration', 'loop', 'cli', 'subsystems', 'gateway', 'web', 'webui']) {
    if (spec.includes(`/${layer}/`) || spec.endsWith(`/${layer}`) || spec === `./${layer}` || spec === `../${layer}`) {
      hit.push(layer);
    }
  }
  return hit;
}

function packageForbiddenTargets(spec: string): string[] {
  const hit: string[] = [];
  if (spec.startsWith('@octopi-agent/engine/')) {
    for (const layer of ['harness', 'integration', 'gateway', 'cli', 'web']) {
      if (spec.includes(`/${layer}/`) || spec.endsWith(`/${layer}`)) hit.push(layer);
    }
  }
  return hit;
}

describe('architecture boundaries', () => {
  const coreFiles = walkTsFiles(CORE_SRC);
  const engineFiles = walkTsFiles(ENGINE_SRC);
  const gatewayFiles = walkTsFiles(GATEWAY_SRC);
  const rootFiles = walkTsFiles(SRC);

  it('core does not import harness / integration / loop / cli / subsystems', () => {
    const violations: string[] = [];
    for (const file of coreFiles) {
      const rel = relative(CORE_SRC, file).split(sep).join('/');
      // package facade may re-export loop; Layer-1 core/ must not
      const isCore = !rel.startsWith('loop/') && rel !== 'index.ts';
      if (!isCore) continue;
      const source = readFileSync(file, 'utf8');
      for (const spec of extractImports(source)) {
        const hits = forbiddenTargets(spec).filter((h) =>
          ['harness', 'integration', 'loop', 'cli', 'subsystems'].includes(h),
        );
        if (hits.length > 0) {
          violations.push(`${rel}: ${spec}`);
        }
        if (packageForbiddenTargets(spec).length > 0) {
          violations.push(`${rel}: ${spec}`);
        }
      }
    }
    expect(violations, `Core→outer imports:\n${violations.join('\n')}`).toEqual([]);
  });

  it('loop does not import harness / integration', () => {
    const violations: string[] = [];
    for (const file of coreFiles) {
      const rel = relative(CORE_SRC, file).split(sep).join('/');
      const isLoop = rel.startsWith('loop/');
      if (!isLoop) continue;
      const source = readFileSync(file, 'utf8');
      for (const spec of extractImports(source)) {
        const hits = forbiddenTargets(spec).filter(
          (h) => h === 'harness' || h === 'integration',
        );
        if (hits.length > 0) {
          violations.push(`${rel}: ${spec}`);
        }
      }
    }
    expect(violations, `Loop→outer imports:\n${violations.join('\n')}`).toEqual([]);
  });

  it('harness does not import integration / gateway / cli / web', () => {
    const violations: string[] = [];
    for (const file of engineFiles) {
      const rel = relative(ENGINE_SRC, file).split(sep).join('/');
      if (!rel.startsWith('harness/')) continue;
      const source = readFileSync(file, 'utf8');
      for (const spec of extractImports(source)) {
        const hits = forbiddenTargets(spec).filter((h) =>
          ['integration', 'gateway', 'cli', 'web', 'webui'].includes(h),
        );
        if (hits.length > 0) {
          violations.push(`${rel}: ${spec}`);
        }
        if (spec.startsWith('@octopi-agent/engine/integration')) {
          violations.push(`${rel}: ${spec}`);
        }
        // engine must not reach gateway/cli/web through relative escapes
        if (/\/(gateway|cli|web|webui)(\/|$)/.test(spec) && spec.startsWith('.')) {
          violations.push(`${rel}: ${spec}`);
        }
      }
    }
    expect(
      violations,
      `Harness→outer imports:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('engine does not import gateway / suite cli', () => {
    const violations: string[] = [];
    for (const file of engineFiles) {
      const rel = relative(ENGINE_SRC, file).split(sep).join('/');
      const source = readFileSync(file, 'utf8');
      for (const spec of extractImports(source)) {
        if (spec.startsWith('@octopi-agent/gateway')) {
          violations.push(`${rel}: ${spec}`);
        }
        if (spec.includes('/cli/') || spec.endsWith('/cli')) {
          violations.push(`${rel}: ${spec}`);
        }
      }
    }
    expect(violations, `Engine→gateway/cli:\n${violations.join('\n')}`).toEqual([]);
  });

  it('gateway does not import suite cli / root init IO', () => {
    const violations: string[] = [];
    for (const file of gatewayFiles) {
      const rel = relative(GATEWAY_SRC, file).split(sep).join('/');
      const source = readFileSync(file, 'utf8');
      for (const spec of extractImports(source)) {
        if (spec.includes('/cli/') || spec.endsWith('/cli')) {
          violations.push(`${rel}: ${spec}`);
        }
        // suite init (scaffolding) must not leak into gateway; paths live in engine
        if (/(\.\.\/)+init(\.js)?$/.test(spec)) {
          violations.push(`${rel}: ${spec}`);
        }
      }
    }
    expect(violations, `Gateway→suite:\n${violations.join('\n')}`).toEqual([]);
  });

  it('engine does not hold migrated domain contracts', () => {
    const gone = [
      'memory.ts',
      'knowledge-store.ts',
      'cognitive-loop.ts',
      'async-task-store.ts',
      'agent-registry.ts',
      'mcp-client.ts',
      'human-in-the-loop.ts',
      'web-search.ts',
      'execution-environment.ts',
      'event-source.ts',
      'message-channel.ts',
      'domain.ts',
      'context-engine.ts',
      'events.ts',
    ];
    for (const f of gone) {
      expect(() => readFileSync(join(CORE_SRC, 'core', 'interfaces', f)), f).toThrow();
    }
  });

  it('core/index (package entry) is Kernel-only — no Domain ports', () => {
    const index = readFileSync(join(CORE_SRC, 'core', 'index.ts'), 'utf8');
    expect(index).not.toMatch(/interfaces\/domain\.js/);
    expect(index).not.toMatch(/from\s+['"]\.\/domain\.js['"]/);
    expect(index).toMatch(/interfaces\/kernel\.js/);
  });

  it('core/domain entry removed (Domain lives in harness)', () => {
    expect(() => readFileSync(join(CORE_SRC, 'core', 'domain.ts'))).toThrow();
  });
});
