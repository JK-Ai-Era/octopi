/**
 * Architecture boundary tests
 *
 * Enforces dependency direction:
 * - src/core  → no harness / integration / loop / cli / subsystems
 * - src/loop  → no harness / integration
 *
 * These rules are also mirrored in eslint.config.js (no-restricted-imports).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
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

/** Extract relative import specifiers from a TS source file. */
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

function layerOf(file: string): 'core' | 'loop' | 'other' {
  const rel = relative(SRC, file).split(sep).join('/');
  if (rel.startsWith('core/')) return 'core';
  if (rel.startsWith('loop/')) return 'loop';
  return 'other';
}

function forbiddenTargets(spec: string): string[] {
  // Only relative imports can leave a layer; package imports are external.
  if (!spec.startsWith('.')) return [];
  const hit: string[] = [];
  // Normalize roughly by checking path segments in the specifier
  for (const layer of ['harness', 'integration', 'loop', 'cli', 'subsystems']) {
    if (spec.includes(`/${layer}/`) || spec.endsWith(`/${layer}`) || spec === `./${layer}` || spec === `../${layer}`) {
      hit.push(layer);
    }
  }
  return hit;
}

describe('architecture boundaries', () => {
  const files = walkTsFiles(SRC);

  it('core does not import harness / integration / loop / cli / subsystems', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (layerOf(file) !== 'core') continue;
      const source = readFileSync(file, 'utf8');
      for (const spec of extractImports(source)) {
        // core → loop is forbidden (loop is Layer 0, depends on core)
        // but allow nothing outer
        const hits = forbiddenTargets(spec);
        // For core files, ANY of harness/integration/loop/cli/subsystems is bad
        if (hits.length > 0) {
          violations.push(`${relative(SRC, file).split(sep).join('/')}: ${spec}`);
        }
      }
    }
    expect(violations, `Core→outer imports:\n${violations.join('\n')}`).toEqual([]);
  });

  it('loop does not import harness / integration', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (layerOf(file) !== 'loop') continue;
      const source = readFileSync(file, 'utf8');
      for (const spec of extractImports(source)) {
        const hits = forbiddenTargets(spec).filter(
          (h) => h === 'harness' || h === 'integration',
        );
        if (hits.length > 0) {
          violations.push(`${relative(SRC, file).split(sep).join('/')}: ${spec}`);
        }
      }
    }
    expect(violations, `Loop→outer imports:\n${violations.join('\n')}`).toEqual([]);
  });

  it('core does not hold migrated domain contracts', () => {
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
      expect(() => readFileSync(join(SRC, 'core', 'interfaces', f)), f).toThrow();
    }
  });

  it('core/index (package entry) is Kernel-only — no Domain ports', () => {
    const index = readFileSync(join(SRC, 'core', 'index.ts'), 'utf8');
    expect(index).not.toMatch(/interfaces\/domain\.js/);
    expect(index).not.toMatch(/from\s+['"]\.\/domain\.js['"]/);
    expect(index).toMatch(/interfaces\/kernel\.js/);
  });

  it('core/domain entry removed (Domain lives in harness)', () => {
    expect(() => readFileSync(join(SRC, 'core', 'domain.ts'))).toThrow();
  });
});
