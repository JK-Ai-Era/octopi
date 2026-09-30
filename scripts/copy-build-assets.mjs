/**
 * 根套件构建后检查（业务资产已在 engine 包内拷贝）。
 * node scripts/copy-build-assets.mjs
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const engineConstitution = join(root, 'packages', 'engine', 'dist', 'harness', 'context', 'constitution', 'default-agents.md');
if (!existsSync(engineConstitution)) {
  console.warn(`[copy-build-assets] engine constitution missing at ${engineConstitution}`);
} else {
  console.log('[copy-build-assets] engine constitution ok');
}

const engineSubsystems = join(root, 'packages', 'engine', 'dist', 'subsystems');
if (!existsSync(engineSubsystems)) {
  console.warn(`[copy-build-assets] engine subsystems missing at ${engineSubsystems}`);
} else {
  console.log('[copy-build-assets] engine subsystems ok');
}
