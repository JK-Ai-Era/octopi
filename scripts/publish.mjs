/**
 * Publish the five lockstep packages in dependency order.
 *
 *   node scripts/publish.mjs             # publish what is missing
 *   node scripts/publish.mjs --dry-run   # pack + report, upload nothing
 *
 * Runs from `.github/workflows/ci.yml` (job `publish`) on a `v<X.Y.Z>` tag push,
 * after build / test / lint are green. Three properties are deliberate:
 *
 *   1. Dependency order — internal `@octopi-agent/*` deps are pinned to the
 *      exact version (not `^`), so `core` has to exist on the registry before
 *      `engine`, `gateway`, `webui`, and finally the `octopi-agent` umbrella.
 *
 *   2. Publish-if-absent — a published version cannot be overwritten, so after
 *      a partial failure (core landed, engine failed) a plain retry would die
 *      on EPUBLISHCONFLICT at the first package. The registry is the ledger: an
 *      already-present version is reported `skip` and the run continues. It
 *      never republishes different bytes under an existing version — that would
 *      be a silent supply-chain lie.
 *
 *   3. Fail loud before touching the registry — non-lockstep versions or a
 *      missing `dist` abort the whole run. A version number is spent the moment
 *      it uploads; shipping an empty or mixed suite cannot be taken back.
 *
 * Auth: npm reads `NODE_AUTH_TOKEN` (CI maps it from the `NPM_TOKEN` secret);
 * `setup-node` with `registry-url` writes the matching `.npmrc`.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

/** Publish order: every package appears after the internal deps it consumes. */
const ORDER = ['packages/core', 'packages/engine', 'packages/gateway', 'packages/webui', '.'];

/**
 * @param {string} rel - workspace-relative package dir ('.' for the root suite)
 * @returns {{name: string, version: string}} manifest fields this script needs
 */
function readPkg(rel) {
  const json = JSON.parse(readFileSync(join(root, rel, 'package.json'), 'utf8'));
  return { name: json.name, version: json.version };
}

/**
 * Registry presence of one exact version.
 *
 * Anything other than "found" / "E404" throws: an auth or network failure must
 * never be read as "not published yet", or the run would publish on top of an
 * unknown registry state.
 *
 * @param {string} name - package name (may be scoped)
 * @param {string} version - exact version
 * @returns {'present' | 'absent'}
 */
function registryState(name, version) {
  const res = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (res.status === 0) return 'present';
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (/E404|404 Not Found/.test(output)) return 'absent';
  throw new Error(`npm view ${name}@${version} failed (status ${res.status}):\n${output.trim()}`);
}

/**
 * @param {string} rel - workspace-relative package dir
 */
function assertBuilt(rel) {
  const dir = join(root, rel, 'dist');
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    // Swallowed on purpose: absent dist is exactly the state this guard reports
    // below, so there is no other branch to reach.
  }
  if (entries.length === 0) {
    console.error(`[publish] missing build output: ${rel}/dist is absent or empty — run "npm run build" first`);
    process.exit(1);
  }
}

/**
 * @param {string} rel - workspace-relative package dir
 * @param {{name: string, version: string}} pkg
 */
function publish(rel, pkg) {
  const args = ['publish', '--access', 'public'];
  if (dryRun) args.push('--dry-run');
  const res = spawnSync('npm', args, { cwd: join(root, rel), stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`\n[publish] ${pkg.name}@${pkg.version} failed (exit ${res.status}); re-run to resume after the last successful package`);
    process.exit(res.status ?? 1);
  }
}

const packages = ORDER.map((rel) => ({ rel, ...readPkg(rel) }));

// Lockstep guard: a mixed set would publish a suite whose internal pins point
// at versions that never reach the registry.
const versions = new Set(packages.map((p) => p.version));
if (versions.size !== 1) {
  console.error(
    '[publish] packages are not lockstep-versioned:',
    packages.map((p) => `${p.name}@${p.version}`).join(', '),
  );
  process.exit(1);
}
const version = packages[0].version;

// Tag guard for CI runs: refuse to publish a version the tag does not name.
const tag = process.env.GITHUB_REF_NAME;
if (tag && tag.startsWith('v') && tag !== `v${version}`) {
  console.error(`[publish] tag ${tag} does not name package version ${version}`);
  process.exit(1);
}

for (const pkg of packages) assertBuilt(pkg.rel);

console.log(`[publish] v${version}${dryRun ? ' (dry run)' : ''}`);

const published = [];
const skipped = [];
for (const pkg of packages) {
  const state = registryState(pkg.name, pkg.version);
  if (state === 'present') {
    console.log(`[publish] skip ${pkg.name}@${pkg.version} — already on the registry`);
    skipped.push(pkg.name);
    continue;
  }
  console.log(`[publish] publish ${pkg.name}@${pkg.version}`);
  publish(pkg.rel, pkg);
  published.push(pkg.name);
}

const action = dryRun ? 'would publish' : 'published';
console.log(
  `\n[publish] done: ${published.length} ${action}${published.length ? ` (${published.join(', ')})` : ''}, ` +
    `${skipped.length} already present${skipped.length ? ` (${skipped.join(', ')})` : ''}`,
);
