import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('src/config.ts', 'utf8');
const lines = src.split(/\r?\n/);

function slice(a, b) {
  return lines.slice(a - 1, b).join('\n');
}

const engineHeader = [
  '/**',
  ' * Engine config types + factories (arch/npm-package-split.md §10.3).',
  ' * IO (loadConfig) and gateway mapping stay in the root package.',
  ' */',
  "import type { ToolPolicy } from '@octopi-agent/core/types.js';",
  "import type { AgentDefinition, ModelConfig as _ModelConfig } from './harness/shared/types/agent-definition.js';",
  "import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';",
  "import { DEFAULT_CONTEXT_WINDOW } from '@octopi-agent/core/types/model-info.js';",
  '',
  '/** 产品默认上下文窗口（与 core/types/model-info 一致，未声明能力时按此预算） */',
  'export { DEFAULT_CONTEXT_WINDOW };',
  '',
].join('\n');

const typesBody = slice(58, 934);
const factories = slice(963, 1086);
const normalized = slice(1163, 1183);
const provider = slice(1244, 1264).replaceAll(
  '@octopi-agent/engine/integration/providers/',
  './integration/providers/',
);

const engineConfig = [engineHeader, typesBody, factories, normalized, provider].join('\n\n') + '\n';
writeFileSync('packages/engine/src/config.ts', engineConfig);
console.log('wrote packages/engine/src/config.ts', engineConfig.length);

const loadOnly = slice(1088, 1159);
const toGatewayOnly = slice(1185, 1240);

const rootConfig = [
  '/**',
  ' * 配置系统 — 文件 IO + Gateway 映射（根入口）',
  ' *',
  ' * 类型与工厂在 `@octopi-agent/engine/config.js`；本文件保留 loadConfig / toGatewayConfig。',
  ' * 配置文件查找：-c 指定路径 → ./octopi.json → ~/.octopi/octopi.json',
  ' */',
  "export * from '@octopi-agent/engine/config.js';",
  '',
  "import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';",
  "import type { GatewayConfig } from './integration/types/gateway-config.js';",
  'import type {',
  '  NormalizedHarnessConfig,',
  '  ModelsConfig,',
  "} from '@octopi-agent/engine/config.js';",
  "import { flattenModels, resolveModelConfig } from '@octopi-agent/engine/config.js';",
  "import { validateConfigOrThrow } from './config-schema.js';",
  "import { applyLegacyBudget, detectConfigMigrations } from './config-migrations.js';",
  "import { getOctopiHome } from './init.js';",
  "import { readFileSync, existsSync } from 'node:fs';",
  "import { resolve } from 'node:path';",
  '',
  loadOnly,
  '',
  toGatewayOnly,
  '',
].join('\n');

writeFileSync('src/config.ts', rootConfig);
console.log('wrote src/config.ts', rootConfig.length);
