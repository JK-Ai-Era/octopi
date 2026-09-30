/**
 * Phase 2: extract packages/core (@octopi-agent/core) from src/core + src/loop.
 * Rewrites relative core/loop imports across src/ and tests/ to the package name.
 *
 * Usage: node scripts/extract-core-package.mjs
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgSrc = join(root, 'packages', 'core', 'src');

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ── 1) copy sources into packages/core/src ──
mkdirSync(pkgSrc, { recursive: true });
cpSync(join(root, 'src', 'core'), join(pkgSrc, 'core'), { recursive: true });
cpSync(join(root, 'src', 'loop'), join(pkgSrc, 'loop'), { recursive: true });

// Flatten: move core/* up is NOT done — keep core/ and loop/ as subpaths of the package
// so @octopi-agent/core/types.js maps to packages/core/src/core/types.js via exports "./*"
// Actually simpler: exports map to ./src/core/* for legacy paths.
// We'll instead place a root index and map:
//   @octopi-agent/core          -> src/index.ts
//   @octopi-agent/core/types.js -> src/core/types.js
//   @octopi-agent/core/loop/x.js -> src/loop/x.js

// ── 2) rewrite imports in packages/core (loop -> core siblings) ──
for (const file of walk(pkgSrc)) {
  if (!file.endsWith('.ts')) continue;
  let text = readFileSync(file, 'utf8');
  const before = text;
  // loop's ../core/X -> ../core/X stays valid under packages/core/src/loop
  // only rewrite absolute-ish package self refs if any
  if (text !== before) writeFileSync(file, text);
}

// ── 3) rewrite imports in src/ and tests/ ──
const rewriteRoots = [join(root, 'src'), join(root, 'tests')];
let changedFiles = 0;
let changedImports = 0;

/** @param {string} spec */
function rewriteSpec(spec) {
  // relative core
  let m = spec.match(/^(\.\.\/)+core\/(.+)$/);
  if (m) {
    changedImports++;
    return `@octopi-agent/core/${m[2]}`;
  }
  m = spec.match(/^\.\/core\/(.+)$/);
  if (m) {
    changedImports++;
    return `@octopi-agent/core/${m[2]}`;
  }
  // relative loop -> package loop subpath
  m = spec.match(/^(\.\.\/)+loop\/(.+)$/);
  if (m) {
    changedImports++;
    return `@octopi-agent/core/loop/${m[2]}`;
  }
  m = spec.match(/^\.\/loop\/(.+)$/);
  if (m) {
    changedImports++;
    return `@octopi-agent/core/loop/${m[2]}`;
  }
  // tests: ../src/core or ../../src/core
  m = spec.match(/^(\.\.\/)+src\/core\/(.+)$/);
  if (m) {
    changedImports++;
    return `@octopi-agent/core/${m[2]}`;
  }
  m = spec.match(/^(\.\.\/)+src\/loop\/(.+)$/);
  if (m) {
    changedImports++;
    return `@octopi-agent/core/loop/${m[2]}`;
  }
  return spec;
}

for (const dir of rewriteRoots) {
  for (const file of walk(dir)) {
    if (!file.endsWith('.ts')) continue;
    const text = readFileSync(file, 'utf8');
    const next = text.replace(
      /(from\s+|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g,
      (full, prefix, q, spec) => {
        const out = rewriteSpec(spec);
        return out === spec ? full : `${prefix}${q}${out}${q}`;
      },
    );
    if (next !== text) {
      writeFileSync(file, next);
      changedFiles++;
    }
  }
}

// ── 4) package.json for @octopi-agent/core ──
const corePkg = {
  name: '@octopi-agent/core',
  version: '0.1.0',
  description: 'Octopi Core — agentLoop + Kernel 契约（Layer 0–1）',
  type: 'module',
  license: 'Apache-2.0',
  main: './dist/core/index.js',
  types: './dist/core/index.d.ts',
  exports: {
    '.': {
      types: './dist/core/index.d.ts',
      import: './dist/core/index.js',
    },
    './loop': {
      types: './dist/loop/index.d.ts',
      import: './dist/loop/index.js',
    },
    './loop/*': {
      types: './dist/loop/*.d.ts',
      import: './dist/loop/*.js',
    },
    './package.json': './package.json',
    './*': {
      types: './dist/core/*.d.ts',
      import: './dist/core/*.js',
    },
  },
  files: ['dist', 'src/core', 'src/loop', 'README.md'],
  scripts: {
    build: 'tsc -p tsconfig.json',
    dev: 'tsc -p tsconfig.json --watch',
  },
  engines: { node: '>=24' },
};
mkdirSync(join(root, 'packages', 'core'), { recursive: true });
writeFileSync(
  join(root, 'packages', 'core', 'package.json'),
  JSON.stringify(corePkg, null, 2) + '\n',
);

writeFileSync(
  join(root, 'packages', 'core', 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2023',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ES2023'],
        types: ['node'],
        rootDir: 'src',
        outDir: 'dist',
        strict: true,
        esModuleInterop: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        resolveJsonModule: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2,
  ) + '\n',
);

// package entry re-export (core + loop)
writeFileSync(
  join(pkgSrc, 'index.ts'),
  `/**
 * @octopi-agent/core — Layer 0 Loop + Layer 1 Kernel
 */
export * from './core/index.js';
export * from './loop/index.js';
`,
);

// ── 5) root tsconfig paths for monorepo resolution ──
const tsconfigPath = join(root, 'tsconfig.json');
const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
tsconfig.compilerOptions = tsconfig.compilerOptions || {};
tsconfig.compilerOptions.paths = {
  '@octopi-agent/core/loop': ['packages/core/src/loop/index.ts'],
  '@octopi-agent/core/loop/*': ['packages/core/src/loop/*'],
  '@octopi-agent/core': ['packages/core/src/core/index.ts'],
  '@octopi-agent/core/*': ['packages/core/src/core/*'],
};
// keep rootDir src — only remaining src is harness/integration/cli...
writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n');

console.log(`[extract-core] packages/core/src populated`);
console.log(`[extract-core] rewritten files: ${changedFiles}, imports: ${changedImports}`);
console.log(`[extract-core] next: remove src/core src/loop, wire workspaces, build+test`);
