/**
 * Lockstep release prep for the five Octopi packages (arch/npm-package-split.md).
 *
 * Sets the same version on:
 *   octopi-agent, @octopi-agent/{core,engine,gateway,webui}
 * and pins internal @octopi-agent/* dependencies to that exact version.
 *
 * Usage:
 *   node scripts/release.mjs prep 0.56.0
 *   node scripts/release.mjs print
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = [
  'package.json',
  'packages/core/package.json',
  'packages/engine/package.json',
  'packages/gateway/package.json',
  'packages/webui/package.json',
];
const INTERNAL = [
  '@octopi-agent/core',
  '@octopi-agent/engine',
  '@octopi-agent/gateway',
  '@octopi-agent/webui',
];

function readPkg(rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'));
}

function writePkg(rel, json) {
  writeFileSync(join(root, rel), JSON.stringify(json, null, 2) + '\n');
}

function pinInternal(json, version) {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const bag = json[field];
    if (!bag) continue;
    for (const name of INTERNAL) {
      if (bag[name]) bag[name] = version;
    }
  }
}

function prep(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('[release] version must be X.Y.Z, got:', version);
    process.exit(1);
  }
  for (const rel of PACKAGES) {
    const json = readPkg(rel);
    json.version = version;
    pinInternal(json, version);
    writePkg(rel, json);
    console.log('[release]', json.name, '→', version);
  }
  console.log('\nNext:');
  console.log('  1. Update CHANGELOG.md under v' + version);
  console.log('  2. git add -A && git commit -m "chore(release): v' + version + '"');
  console.log('  3. git tag v' + version);
  console.log('  4. Publish (see `node scripts/release.mjs print`)');
}

function printPublishOrder() {
  const version = readPkg('package.json').version;
  console.log(`Publish order for v${version} (lockstep):\n`);
  console.log(`  npm publish -w packages/core --access public --otp=...`);
  console.log(`  npm publish -w packages/engine --access public --otp=...`);
  console.log(`  npm publish -w packages/gateway --access public --otp=...`);
  console.log(`  npm publish -w packages/webui --access public --otp=...`);
  console.log(`  npm publish --access public --otp=...`);
  console.log('\nCurrent versions:');
  for (const rel of PACKAGES) {
    const json = readPkg(rel);
    const deps = Object.fromEntries(
      INTERNAL.filter((n) => json.dependencies?.[n]).map((n) => [n, json.dependencies[n]]),
    );
    console.log(' ', json.name, json.version, deps);
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'prep') {
  if (!arg) {
    console.error('usage: node scripts/release.mjs prep <X.Y.Z>');
    process.exit(1);
  }
  prep(arg);
} else if (cmd === 'print') {
  printPublishOrder();
} else {
  console.error('usage: node scripts/release.mjs prep <X.Y.Z> | print');
  process.exit(1);
}
