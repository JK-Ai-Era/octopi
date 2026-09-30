/**
 * Phase 2: extract packages/gateway (@octopi-agent/gateway) per arch/npm-package-split.md §10.3.
 *
 * Moves:
 *   src/integration/gateway/**
 *   src/integration/protocols/**
 *   src/integration/web/**          (api/runtime/sdk/conversation — runtime depends on sdk+conversation)
 *   src/integration/types/**
 *   src/config-schema/gateway.ts
 *
 * NOT in scope: integration/tui (suite), cli, init, webui.
 *
 * Usage: node scripts/extract-gateway-package.mjs
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gatewaySrc = join(root, 'packages', 'gateway', 'src');

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

function moveDir(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

function moveFile(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

// ── 1) package skeleton ──
mkdirSync(gatewaySrc, { recursive: true });

const gatewayPkg = {
  name: '@octopi-agent/gateway',
  version: '0.1.0',
  description: 'Octopi Gateway — HTTP/WS 进程面 + Channel 挂载 + Web 运行时',
  type: 'module',
  license: 'Apache-2.0',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.js',
    },
    './package.json': './package.json',
    // `*` passes through `.js` (do NOT write ./dist/*.js)
    './gateway/*': {
      types: './dist/gateway/*',
      import: './dist/gateway/*',
    },
    './protocols/*': {
      types: './dist/protocols/*',
      import: './dist/protocols/*',
    },
    './web/*': {
      types: './dist/web/*',
      import: './dist/web/*',
    },
    './types/*': {
      types: './dist/types/*',
      import: './dist/types/*',
    },
    './config-schema/*': {
      types: './dist/config-schema/*',
      import: './dist/config-schema/*',
    },
    './*': {
      types: './dist/*',
      import: './dist/*',
    },
  },
  files: ['dist', 'src', 'README.md'],
  scripts: {
    build: 'tsc -p tsconfig.json',
    dev: 'tsc -p tsconfig.json --watch',
  },
  engines: { node: '>=24' },
  dependencies: {
    '@octopi-agent/core': '*',
    '@octopi-agent/engine': '*',
    ws: '^8.21.0',
    zod: '^4.4.3',
  },
  devDependencies: {
    '@types/ws': '^8.18.1',
  },
};

writeFileSync(
  join(root, 'packages', 'gateway', 'package.json'),
  JSON.stringify(gatewayPkg, null, 2) + '\n',
);

writeFileSync(
  join(root, 'packages', 'gateway', 'tsconfig.json'),
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

// ── 2) move sources (preserve sibling layout under src/) ──
moveDir(join(root, 'src', 'integration', 'gateway'), join(gatewaySrc, 'gateway'));
moveDir(join(root, 'src', 'integration', 'protocols'), join(gatewaySrc, 'protocols'));
moveDir(join(root, 'src', 'integration', 'web'), join(gatewaySrc, 'web'));
moveDir(join(root, 'src', 'integration', 'types'), join(gatewaySrc, 'types'));
moveFile(join(root, 'src', 'config-schema', 'gateway.ts'), join(gatewaySrc, 'config-schema', 'gateway.ts'));

// ── 3) gateway barrel ──
writeFileSync(
  join(gatewaySrc, 'index.ts'),
  `/**
 * @octopi-agent/gateway — HTTP/WS 进程面 + Channel + Web 运行时
 */

export { Gateway } from './gateway/gateway.js';
export type { GatewayConfig } from './types/gateway-config.js';
export { GatewayChatClient } from './gateway/client.js';
export { HttpChannelAdapter } from './protocols/http.js';
export type { StreamingChannelAdapter } from './protocols/http.js';
export { createWebApiRouter } from './web/api/router.js';
export { OctopiClient } from './web/sdk/client.js';
export type {
  AgentEventEnvelope,
  MessageRecord,
  SessionTaskView,
  ModelCatalog,
  SessionModelView,
  CommandCatalogItemDto,
  PendingQuestion,
} from './web/sdk/client.js';
export { OctopiRuntimeStore } from './web/runtime/store.js';
export type { RunStatus, InspectorState } from './web/runtime/store.js';
export { ConversationAdapter } from './web/conversation/adapter.js';
export type { AdapterSnapshot } from './web/conversation/adapter.js';
export type {
  ConversationItem,
  ToolConversationItem,
  ViewMode,
} from './web/conversation/types.js';
export { GatewayOverrideConfigSchema } from './config-schema/gateway.js';
`,
);

// ── 4) engine paths helper (getOctopiHome shared; gateway must not import suite init) ──
writeFileSync(
  join(root, 'packages', 'engine', 'src', 'paths.ts'),
  `/**
 * Runtime home path helpers (OCTOPI_HOME).
 * Shared by gateway / suite so neither depends on the other for path resolution.
 */
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** 默认系统根目录 */
export const DEFAULT_OCTOPI_HOME = join(homedir(), '.octopi');

/** 环境变量名 */
export const OCTOPI_HOME_ENV = 'OCTOPI_HOME';

/**
 * 获取 Octopi 系统根目录
 *
 * 优先级：
 * 1. 环境变量 OCTOPI_HOME
 * 2. 默认值 ~/.octopi
 *
 * @returns 绝对路径
 */
export function getOctopiHome(): string {
  return resolve(process.env[OCTOPI_HOME_ENV] ?? DEFAULT_OCTOPI_HOME);
}
`,
);

// ── 5) rewrite imports ──
/**
 * @param {string} spec
 * @returns {string}
 */
function rewriteSpec(spec) {
  if (spec.startsWith('@octopi-agent/')) {
    // gateway-config type imports pointed at root config via relative path; after move use engine
    return spec;
  }
  if (!spec.startsWith('.')) return spec;

  // tests / webui: ../src/integration/{gateway,protocols,web,types}/...
  let m = spec.match(/^(\.\.\/)+src\/integration\/(gateway|protocols|web|types)\/(.+)$/);
  if (m) return `@octopi-agent/gateway/${m[2]}/${m[3]}`;

  m = spec.match(/^(\.\.\/)+src\/integration\/(gateway|protocols|web|types)$/);
  if (m) return `@octopi-agent/gateway/${m[2]}`;

  // webui: ../../../src/integration/web/...
  m = spec.match(/^(\.\.\/)+src\/integration\/(gateway|protocols|web|types)\/(.+)$/);
  if (m) return `@octopi-agent/gateway/${m[2]}/${m[3]}`;

  // root-relative to integration slices
  m = spec.match(/^(\.\.\/)+integration\/(gateway|protocols|web|types)\/(.+)$/);
  if (m) return `@octopi-agent/gateway/${m[2]}/${m[3]}`;
  m = spec.match(/^\.\/integration\/(gateway|protocols|web|types)\/(.+)$/);
  if (m) return `@octopi-agent/gateway/${m[2]}/${m[3]}`;

  // tui: ../gateway/client.js
  m = spec.match(/^(\.\.\/)+gateway\/(.+)$/);
  if (m) return `@octopi-agent/gateway/gateway/${m[2]}`;
  m = spec.match(/^\.\/gateway\/(.+)$/);
  if (m) return `@octopi-agent/gateway/gateway/${m[1]}`;

  // protocols sibling from gateway.ts already relative and stays valid inside package

  // config-schema/gateway.js from root
  m = spec.match(/^(\.\.\/)+config-schema\/gateway(\.js)?$/);
  if (m) return '@octopi-agent/gateway/config-schema/gateway.js';
  m = spec.match(/^\.\/config-schema\/gateway(\.js)?$/);
  if (m) return '@octopi-agent/gateway/config-schema/gateway.js';
  m = spec.match(/^\.\/gateway(\.js)?$/);
  if (m) return '@octopi-agent/gateway/config-schema/gateway.js';

  // integration/types from root
  m = spec.match(/^(\.\.\/)+integration\/types\/(.+)$/);
  if (m) return `@octopi-agent/gateway/types/${m[2]}`;
  m = spec.match(/^\.\/integration\/types\/(.+)$/);
  if (m) return `@octopi-agent/gateway/types/${m[1]}`;
  m = spec.match(/^(\.\.\/)+types\/gateway-config(\.js)?$/);
  if (m) return '@octopi-agent/gateway/types/gateway-config.js';

  // moved sources that referenced root config / init
  m = spec.match(/^(\.\.\/)+config(\.js)?$/);
  if (m) return '@octopi-agent/engine/config.js';
  m = spec.match(/^(\.\.\/)+init(\.js)?$/);
  if (m) return '@octopi-agent/engine/paths.js';

  return spec;
}

/** rewrite dynamic import('../../init.js') style already covered; also import type('...') */
const rewriteDirs = [join(root, 'src'), join(root, 'tests'), join(root, 'packages', 'webui', 'src'), gatewaySrc];
let changedFiles = 0;
let changedImports = 0;

for (const dir of rewriteDirs) {
  for (const file of walk(dir)) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx') && !file.endsWith('.mts')) continue;
    const text = readFileSync(file, 'utf8');
    const next = text.replace(
      /(from\s+|import\s*\(\s*|import\s+|export\s+\*\s+from\s+|export\s+\{[^}]*\}\s+from\s+|import\s+type\s*\(\s*)(['"])([^'"]+)\2/g,
      (full, prefix, q, spec) => {
        // import type('...') closing paren handling: only rewrite the specifier
        const out = rewriteSpec(spec);
        if (out === spec) return full;
        changedImports++;
        return `${prefix}${q}${out}${q}`;
      },
    );
    // also bare import('...') already covered; fix import type('...') separately
    const next2 = next.replace(
      /import\s+type\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
      (full, q, spec) => {
        const out = rewriteSpec(spec);
        if (out === spec) return full;
        changedImports++;
        return full.replace(spec, out);
      },
    );
    if (next2 !== text) {
      writeFileSync(file, next2);
      changedFiles++;
    }
  }
}

// gateway-config type refs: import('../../config.js') after move from packages/gateway/src/types
// rewriteSpec maps ../config.js only; the type import uses '../../config.js'
for (const file of walk(gatewaySrc)) {
  if (!file.endsWith('.ts')) continue;
  const text = readFileSync(file, 'utf8');
  const next = text
    .replaceAll("import('../../config.js')", "import('@octopi-agent/engine/config.js')")
    .replaceAll('import("../../config.js")', 'import("@octopi-agent/engine/config.js")')
    .replaceAll("import('../../init.js')", "import('@octopi-agent/engine/paths.js')")
    .replaceAll('import("../../init.js")', 'import("@octopi-agent/engine/paths.js")');
  if (next !== text) {
    writeFileSync(file, next);
    changedFiles++;
    console.log('[extract-gateway] fixed type/dynamic imports:', file);
  }
}

console.log('[extract-gateway] packages/gateway/src populated');
console.log(`[extract-gateway] rewritten files: ${changedFiles}, imports: ${changedImports}`);
console.log('[extract-gateway] next: wire root package/vitest/eslint/index, then test+build+lint');
