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

/**
 * Sync version fields in package-lock.json: top-level `version`, the `""`
 * root entry, and each workspace entry (version + internal @octopi-agent/*
 * pins in dependencies/devDependencies/peerDependencies). Third-party
 * entries are never touched. Without this the lockfile silently drifted
 * (it had lagged since the v0.55.x era — still 0.83.8 while packages shipped
 * 0.83.9; v0.83.10 caught it up by hand).
 *
 * Fails closed on anything except a genuinely absent lockfile: a corrupt
 * file or missing workspace entries must abort prep, never half-sync.
 *
 * @param {string} version - lockstep version to write
 * @param {string[]} lockKeys - lockfile `packages` keys for the five workspaces ("" for root)
 */
function syncLockfile(version, lockKeys) {
  const rel = 'package-lock.json';
  let lock;
  try {
    lock = readPkg(rel);
  } catch (err) {
    // Swallow only ENOENT (repo without a lockfile); anything else must fail.
    if (err && err.code === 'ENOENT') {
      console.log('[release]', rel, 'not found; skipped');
      return;
    }
    throw err;
  }
  if (!lock.packages || typeof lock.packages !== 'object') {
    console.error('[release]', rel, 'has no "packages" map (lockfileVersion < 3?); refusing to half-sync');
    process.exit(1);
  }
  if (typeof lock.version !== 'string') {
    console.error('[release]', rel, 'has no top-level "version"; refusing to half-sync');
    process.exit(1);
  }
  lock.version = version;
  const missing = [];
  for (const key of lockKeys) {
    const entry = lock.packages[key];
    if (!entry || typeof entry !== 'object') {
      missing.push(key === '' ? '(root)' : key);
      continue;
    }
    entry.version = version;
    pinInternal(entry, version);
  }
  if (missing.length > 0) {
    console.error('[release]', rel, 'missing expected workspace entries:', missing.join(', '));
    process.exit(1);
  }
  writePkg(rel, lock);
  console.log('[release]', rel, '→', version);
}

function prep(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('[release] version must be X.Y.Z, got:', version);
    process.exit(1);
  }
  const lockKeys = [];
  for (const rel of PACKAGES) {
    const json = readPkg(rel);
    json.version = version;
    pinInternal(json, version);
    writePkg(rel, json);
    lockKeys.push(rel === 'package.json' ? '' : rel.slice(0, -'/package.json'.length));
    console.log('[release]', json.name, '→', version);
  }
  syncLockfile(version, lockKeys);
  console.log('\nNext:');
  console.log('  1. Prepend "## v' + version + ' (YYYY-MM-DD)" to CHANGELOG.md below the index (AGENTS.md → Changelog Discipline)');
  console.log('  2. Commit code + version files (incl. package-lock.json) + CHANGELOG together');
  console.log('     (stage the intended paths explicitly; avoid `git add -A`)');
  console.log('  3. Tag the commit right away: `git tag v' + version + '` (tagging belongs to the commit flow)');
  console.log('     (publish is user-driven: `node scripts/release.mjs print`)');
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
