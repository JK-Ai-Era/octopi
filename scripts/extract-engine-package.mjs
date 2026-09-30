/**
 * Phase 2: extract packages/engine (@octopi-agent/engine) per arch/npm-package-split.md §10.3.
 *
 * Moves:
 *   src/harness/**
 *   src/integration/{providers,storage,mcp,observability,web-search,agent-runtime}
 *   src/config-schema/{shared,agent,models,run,context,substrate,governance,observability,web-search,subsystems,engine}.ts
 *   src/builtin-model-info.ts
 *   src/types/sqlite-vec.d.ts
 *   src/config.ts → engine types/factories (IO stays at root; handled after this script)
 *
 * Rewrites remaining src/ + tests/ imports to package subpaths.
 *
 * Usage: node scripts/extract-engine-package.mjs
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engineSrc = join(root, 'packages', 'engine', 'src');

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
mkdirSync(engineSrc, { recursive: true });

const enginePkg = {
  name: '@octopi-agent/engine',
  version: '0.1.0',
  description: 'Octopi Engine — Harness 10 域 + Integration 库能力',
  type: 'module',
  license: 'Apache-2.0',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.js',
    },
    './harness': {
      types: './dist/harness/index.d.ts',
      import: './dist/harness/index.js',
    },
    './harness/orchestration': {
      types: './dist/harness/collaboration/orchestration/index.d.ts',
      import: './dist/harness/collaboration/orchestration/index.js',
    },
    './integration': {
      types: './dist/integration/index.d.ts',
      import: './dist/integration/index.js',
    },
    './plugin-sdk/plugin-entry': {
      types: './dist/harness/extension/plugin-ecosystem/plugins/entry.d.ts',
      import: './dist/harness/extension/plugin-ecosystem/plugins/entry.js',
    },
    './plugin-sdk/api': {
      types: './dist/harness/extension/plugin-ecosystem/plugins/api.d.ts',
      import: './dist/harness/extension/plugin-ecosystem/plugins/api.js',
    },
    './plugin-sdk/manifest': {
      types: './dist/harness/extension/plugin-ecosystem/plugins/manifest.d.ts',
      import: './dist/harness/extension/plugin-ecosystem/plugins/manifest.js',
    },
    './plugin-sdk/capability': {
      types: './dist/harness/extension/plugin-ecosystem/plugins/capability.d.ts',
      import: './dist/harness/extension/plugin-ecosystem/plugins/capability.js',
    },
    './plugin-sdk/loader': {
      types: './dist/harness/extension/plugin-ecosystem/plugins/loader.d.ts',
      import: './dist/harness/extension/plugin-ecosystem/plugins/loader.js',
    },
    './plugin-sdk/manager': {
      types: './dist/harness/extension/plugin-ecosystem/plugins/manager.d.ts',
      import: './dist/harness/extension/plugin-ecosystem/plugins/manager.js',
    },
    './package.json': './package.json',
    // `*` must pass through `.js` (do NOT write ./dist/*.js — that yields *.js.js)
    './harness/*': {
      types: './dist/harness/*',
      import: './dist/harness/*',
    },
    './integration/*': {
      types: './dist/integration/*',
      import: './dist/integration/*',
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
    build: 'tsc -p tsconfig.json && node ./scripts/copy-engine-assets.mjs',
    dev: 'tsc -p tsconfig.json --watch',
  },
  engines: { node: '>=24' },
  dependencies: {
    '@modelcontextprotocol/sdk': '^1.29.0',
    '@octopi-agent/core': '*',
    'js-yaml': '^4.3.2',
    'sqlite-vec': '^0.1.9',
    zod: '^4.4.3',
  },
  optionalDependencies: {
    'sqlite-vec': '^0.1.9',
  },
};

// sqlite-vec is optional; keep only optionalDependencies
delete enginePkg.dependencies['sqlite-vec'];

writeFileSync(
  join(root, 'packages', 'engine', 'package.json'),
  JSON.stringify(enginePkg, null, 2) + '\n',
);

writeFileSync(
  join(root, 'packages', 'engine', 'tsconfig.json'),
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

// engine asset copy (constitution md)
mkdirSync(join(root, 'packages', 'engine', 'scripts'), { recursive: true });
writeFileSync(
  join(root, 'packages', 'engine', 'scripts', 'copy-engine-assets.mjs'),
  `import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'harness', 'context', 'constitution', 'default-agents.md');
const destDir = join(root, 'dist', 'harness', 'context', 'constitution');
const dest = join(destDir, 'default-agents.md');
if (existsSync(src)) {
  await mkdir(destDir, { recursive: true });
  await cp(src, dest);
  console.log('[copy-engine-assets] constitution →', dest);
} else {
  console.error('[copy-engine-assets] FAILED: missing', src);
  process.exitCode = 1;
}
`,
);

// ── 2) move sources ──
moveDir(join(root, 'src', 'harness'), join(engineSrc, 'harness'));
moveDir(join(root, 'src', 'integration', 'providers'), join(engineSrc, 'integration', 'providers'));
moveDir(join(root, 'src', 'integration', 'storage'), join(engineSrc, 'integration', 'storage'));
moveDir(join(root, 'src', 'integration', 'mcp'), join(engineSrc, 'integration', 'mcp'));
moveDir(join(root, 'src', 'integration', 'observability'), join(engineSrc, 'integration', 'observability'));
moveDir(join(root, 'src', 'integration', 'web-search'), join(engineSrc, 'integration', 'web-search'));
moveDir(join(root, 'src', 'integration', 'agent-runtime'), join(engineSrc, 'integration', 'agent-runtime'));

const engineSchemaFiles = [
  'shared.ts',
  'agent.ts',
  'models.ts',
  'run.ts',
  'context.ts',
  'substrate.ts',
  'governance.ts',
  'observability.ts',
  'web-search.ts',
  'subsystems.ts',
  'engine.ts',
];
for (const f of engineSchemaFiles) {
  moveFile(join(root, 'src', 'config-schema', f), join(engineSrc, 'config-schema', f));
}

moveFile(join(root, 'src', 'builtin-model-info.ts'), join(engineSrc, 'builtin-model-info.ts'));
mkdirSync(join(engineSrc, 'types'), { recursive: true });
moveFile(join(root, 'src', 'types', 'sqlite-vec.d.ts'), join(engineSrc, 'types', 'sqlite-vec.d.ts'));

// ── 3) engine integration barrel (engine-owned slices only) ──
writeFileSync(
  join(engineSrc, 'integration', 'index.ts'),
  `/**
 * Integration 层（engine 拥有的库能力）
 *
 * gateway / protocols / tui / web / types 不在本包（见 arch/npm-package-split.md §3.3）。
 */

// ── Storage ──
export { JsonlSessionStore } from './storage/jsonl.js';
export { InMemorySessionStore } from './storage/memory.js';
export { SessionArchiveManager } from './storage/archive-manager.js';
export type { ArchiveManagerOptions } from './storage/archive-manager.js';
export {
  createSqliteSessionIndex,
  rebuildSessionIndexFromStore,
  ensureSessionIndexFresh,
} from './storage/session-index.js';
export type {
  SessionIndexBackend,
  SessionIndexSink,
  SessionIndexPrefilterQuery,
  SessionIndexCandidate,
} from './storage/session-index.js';

// ── Observability ──
export { NoopObserver } from './observability/noop-observer.js';
export { LogObserver } from './observability/log-observer.js';
export { createRunTelemetry } from './observability/run-telemetry.js';

// ── MCP ──
export { SdkMcpClient, createSdkMcpClient } from './mcp/index.js';

// ── Web Search ──
export {
  createDuckDuckGoProvider,
  createTavilyProvider,
  createBraveProvider,
  createSerperProvider,
  createMimoProvider,
  createWebSearchProviderFromSlot,
  resolveWebSearchProviders,
  createWebSearchWithFallback,
} from './web-search/index.js';
export type {
  WebSearchConfig,
  WebSearchProviderSlotConfig,
  ResolvedWebSearchProviders,
} from './web-search/index.js';

// ── Agent Runtime sources ──
export {
  channelMessageToTrigger,
  dispatchChannelMessage,
  WebhookSource,
  FileWatchSource,
} from './agent-runtime/index.js';
export type {
  ChannelMessageSourceOptions,
  WebhookSourceConfig,
  FileWatchSourceConfig,
} from './agent-runtime/index.js';

// ── Providers ──
export { OpenAIProvider } from './providers/openai.js';
export type { OpenAIProviderConfig } from './providers/openai.js';
export { AnthropicProvider } from './providers/anthropic.js';
export type { AnthropicProviderConfig } from './providers/anthropic.js';
`,
);

// ── 4) rewrite imports in remaining root src/ + tests/ + packages/engine ──
const ENGINE_INTEGRATION = new Set([
  'providers',
  'storage',
  'mcp',
  'observability',
  'web-search',
  'agent-runtime',
]);

const ENGINE_SCHEMA = new Set([
  'shared',
  'agent',
  'models',
  'run',
  'context',
  'substrate',
  'governance',
  'observability',
  'web-search',
  'subsystems',
  'engine',
]);

/**
 * @param {string} spec
 * @param {string} filePath
 * @returns {string}
 */
function rewriteSpec(spec, filePath) {
  // already package
  if (spec.startsWith('@octopi-agent/')) return spec;
  if (!spec.startsWith('.')) return spec;

  // Normalize: capture trailing module path after a known top folder
  // Patterns from root-remaining code and tests.

  // tests / any: ../src/harness/... or ../../src/harness/...
  let m = spec.match(/^(\.\.\/)+src\/harness\/(.+)$/);
  if (m) return `@octopi-agent/engine/harness/${m[2]}`;

  m = spec.match(/^(\.\.\/)+src\/builtin-model-info(\.js)?$/);
  if (m) return `@octopi-agent/engine/builtin-model-info.js`;

  m = spec.match(/^(\.\.\/)+src\/types\/sqlite-vec(\.js)?$/);
  if (m) return `@octopi-agent/engine/types/sqlite-vec.js`;

  m = spec.match(/^(\.\.\/)+src\/integration\/([^/]+)\/(.+)$/);
  if (m && ENGINE_INTEGRATION.has(m[2])) {
    return `@octopi-agent/engine/integration/${m[2]}/${m[3]}`;
  }

  m = spec.match(/^(\.\.\/)+src\/config-schema\/([^/.]+)(\.js)?$/);
  if (m && ENGINE_SCHEMA.has(m[2])) {
    return `@octopi-agent/engine/config-schema/${m[2]}.js`;
  }

  // root-relative: ./harness/..., ../harness/..., ../../harness/...
  m = spec.match(/^(\.\.\/)+harness\/(.+)$/);
  if (m) return `@octopi-agent/engine/harness/${m[2]}`;
  m = spec.match(/^\.\/harness\/(.+)$/);
  if (m) return `@octopi-agent/engine/harness/${m[1]}`;

  m = spec.match(/^(\.\.\/)+builtin-model-info(\.js)?$/);
  if (m) return `@octopi-agent/engine/builtin-model-info.js`;
  m = spec.match(/^\.\/builtin-model-info(\.js)?$/);
  if (m) return `@octopi-agent/engine/builtin-model-info.js`;

  // ./integration/<engine>/... or ../integration/<engine>/...
  m = spec.match(/^(\.\.\/)+integration\/([^/]+)\/(.+)$/);
  if (m && ENGINE_INTEGRATION.has(m[2])) {
    return `@octopi-agent/engine/integration/${m[2]}/${m[3]}`;
  }
  m = spec.match(/^\.\/integration\/([^/]+)\/(.+)$/);
  if (m && ENGINE_INTEGRATION.has(m[1])) {
    return `@octopi-agent/engine/integration/${m[1]}/${m[2]}`;
  }

  // config-schema engine-owned files
  m = spec.match(/^(\.\.\/)+config-schema\/([^/.]+)(\.js)?$/);
  if (m && ENGINE_SCHEMA.has(m[2])) {
    return `@octopi-agent/engine/config-schema/${m[2]}.js`;
  }
  m = spec.match(/^\.\/config-schema\/([^/.]+)(\.js)?$/);
  if (m && ENGINE_SCHEMA.has(m[1])) {
    return `@octopi-agent/engine/config-schema/${m[1]}.js`;
  }
  // from packages/engine/src/config-schema/*.ts
  m = spec.match(/^\.\/([^/.]+)(\.js)?$/);
  if (
    m &&
    ENGINE_SCHEMA.has(m[1]) &&
    filePath.replace(/\\/g, '/').includes('/packages/engine/src/config-schema/')
  ) {
    // already relative inside engine config-schema — leave as-is
    return spec;
  }

  return spec;
}

const rewriteDirs = [
  join(root, 'src'),
  join(root, 'tests'),
  engineSrc,
];
let changedFiles = 0;
let changedImports = 0;

for (const dir of rewriteDirs) {
  for (const file of walk(dir)) {
    if (!file.endsWith('.ts') && !file.endsWith('.mts') && !file.endsWith('.tsx')) continue;
    const text = readFileSync(file, 'utf8');
    const next = text.replace(
      /(from\s+|import\s*\(\s*|import\s+|export\s+\*\s+from\s+|export\s+\{[^}]*\}\s+from\s+)(['"])([^'"]+)\2/g,
      (full, prefix, q, spec) => {
        const out = rewriteSpec(spec, file);
        if (out === spec) return full;
        changedImports++;
        return `${prefix}${q}${out}${q}`;
      },
    );
    if (next !== text) {
      writeFileSync(file, next);
      changedFiles++;
    }
  }
}

console.log(`[extract-engine] packages/engine/src populated`);
console.log(`[extract-engine] rewritten files: ${changedFiles}, imports: ${changedImports}`);
console.log('[extract-engine] next: split config.ts, wire index/package/vitest/eslint, then test+build+lint');
