/**
 * Publish the five lockstep packages in dependency order.
 *
 *   node scripts/publish.mjs             # publish what is missing
 *   node scripts/publish.mjs --dry-run   # pack + report, upload nothing
 *
 * Runs from `.github/workflows/ci.yml` (job `publish`) on a `v<X.Y.Z>` tag push,
 * after build / test / lint are green. Every guard below exists because its
 * failure mode is unrecoverable — a published version cannot be edited or
 * deleted, only shadowed by a later one.
 *
 *   1. Dependency order — internal `@octopi-agent/*` deps are pinned to the
 *      exact version (not `^`), so `core` has to exist on the registry before
 *      `engine`, `gateway`, `webui`, and finally the `octopi-agent` umbrella.
 *
 *   2. Lockstep versions — a mixed set would ship a suite whose internal pins
 *      point at versions that never reach the registry.
 *
 *   3. Tag names the version — a mistyped tag publishes the wrong thing.
 *
 *   4. Build output exists — a missing `dist` publishes empty packages.
 *
 *   5. Tarball contains no tool residue — the `files: ["skills"]` allowlist
 *      packs a directory wholesale and .gitignore does NOT prune inside it, so
 *      locally generated `__pycache__`/`.DS_Store` travel into the tarball.
 *
 *   6. No regression — if a higher version is already on the registry, refuse.
 *      Re-pushing an old tag would otherwise move `latest` backwards.
 *
 *   7. Publish-if-absent — a published version cannot be overwritten, so after
 *      a partial failure (core landed, engine failed) a plain retry would die
 *      on EPUBLISHCONFLICT at the first package. The registry is the ledger: an
 *      already-present version is reported `skip` and the run continues. It
 *      never republishes different bytes under an existing version.
 *
 * Auth: npm reads `NODE_AUTH_TOKEN` (CI maps it from the `NPM_TOKEN` secret);
 * `setup-node` with `registry-url` writes the matching `.npmrc`. The target
 * registry is pinned explicitly so a local `~/.npmrc` mirror cannot capture a
 * publish — override with `OCTOPI_PUBLISH_REGISTRY` only in a test setup.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const registry = process.env.OCTOPI_PUBLISH_REGISTRY ?? 'https://registry.npmjs.org';

/** Publish order: every package appears after the internal deps it consumes. */
const ORDER = ['packages/core', 'packages/engine', 'packages/gateway', 'packages/webui', '.'];

/** Files that must never reach a tarball; matches the observed residue classes. */
const RESIDUE = /(^|\/)__pycache__\/|\.pyc$|(^|\/)\.DS_Store$|(^|\/)node_modules\//;

/**
 * @param {string} rel - workspace-relative package dir ('.' for the root suite)
 * @returns {{name: string, version: string}} manifest fields this script needs
 */
function readPkg(rel) {
  const json = JSON.parse(readFileSync(join(root, rel, 'package.json'), 'utf8'));
  return { name: json.name, version: json.version };
}

/**
 * @param {string[]} args - npm argv (registry is appended here, never by callers)
 * @param {string} cwd - working directory for the npm process
 * @returns {{status: number|null, stdout: string, stderr: string}} raw result
 */
function npm(args, cwd = root) {
  const res = spawnSync('npm', [...args, '--registry', registry], { cwd, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
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
  const res = npm(['view', `${name}@${version}`, 'version', '--json']);
  if (res.status === 0) return 'present';
  if (/E404|404 Not Found/.test(res.stdout + res.stderr)) return 'absent';
  throw new Error(`npm view ${name}@${version} failed (status ${res.status}):\n${(res.stdout + res.stderr).trim()}`);
}

/**
 * `X.Y.Z` comparison; the release discipline guarantees numeric triples, so a
 * dependency on semver would be dead weight here.
 *
 * @param {string} a - version
 * @param {string} b - version
 * @returns {number} negative / zero / positive like a comparator
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Highest published version of one package, or `null` when it has none yet.
 *
 * @param {string} name - package name
 * @returns {string | null} latest dist-tag version
 */
function publishedLatest(name) {
  const res = npm(['view', name, 'version', '--json']);
  if (res.status !== 0) {
    if (/E404|404 Not Found/.test(res.stdout + res.stderr)) return null;
    throw new Error(`npm view ${name} version failed (status ${res.status}):\n${(res.stdout + res.stderr).trim()}`);
  }
  return JSON.parse(res.stdout.trim());
}

/**
 * @param {string} rel - workspace-relative package dir
 */
function assertBuilt(rel) {
  let entries = [];
  try {
    entries = readdirSync(join(root, rel, 'dist'));
  } catch {
    // Swallowed on purpose: absent dist is exactly the state reported below, so
    // there is no other branch to reach.
  }
  if (entries.length === 0) {
    fail(`missing build output: ${rel}/dist is absent or empty`, 'run "npm run build" first');
  }
}

/**
 * Verify the file list npm would actually upload — not the working tree, and not
 * what .gitignore suggests.
 *
 * @param {string} rel - workspace-relative package dir
 * @param {string} name - package name (for the message)
 */
function assertPackClean(rel, name) {
  const res = npm(['pack', '--dry-run', '--json'], join(root, rel));
  if (res.status !== 0) {
    fail(`npm pack --dry-run failed for ${name}`, (res.stdout + res.stderr).trim());
  }
  const { files } = JSON.parse(res.stdout)[0];
  const junk = files.map((f) => f.path).filter((p) => RESIDUE.test(p));
  if (junk.length > 0) {
    fail(
      `${name} tarball contains ${junk.length} residue file(s)`,
      `${junk.slice(0, 10).join('\n')}${junk.length > 10 ? `\n… ${junk.length - 10} more` : ''}`,
    );
  }
}

/**
 * @param {string} what - the failed invariant
 * @param {string} detail - evidence or the next action
 */
function fail(what, detail) {
  console.error(`[publish] ${what}\n${detail}`);
  process.exit(1);
}

/**
 * @param {string} rel - workspace-relative package dir
 * @param {{name: string, version: string}} pkg
 */
function publish(rel, pkg) {
  const args = ['publish', '--access', 'public', '--registry', registry];
  if (dryRun) args.push('--dry-run');
  const res = spawnSync('npm', args, { cwd: join(root, rel), stdio: 'inherit' });
  if (res.status !== 0) {
    fail(
      `${pkg.name}@${pkg.version} failed (exit ${res.status})`,
      're-run to resume after the last successful package',
    );
  }
}

const packages = ORDER.map((rel) => ({ rel, ...readPkg(rel) }));
const version = packages[0].version;

if (new Set(packages.map((p) => p.version)).size !== 1) {
  fail('packages are not lockstep-versioned', packages.map((p) => `${p.name}@${p.version}`).join(', '));
}

const tag = process.env.GITHUB_REF_NAME;
if (tag && tag.startsWith('v') && tag !== `v${version}`) {
  fail(`tag ${tag} does not name package version ${version}`, 'a tag publishes exactly the version it names');
}

for (const pkg of packages) assertBuilt(pkg.rel);
for (const pkg of packages) assertPackClean(pkg.rel, pkg.name);

const latest = publishedLatest('octopi-agent');
if (latest !== null && compareVersions(version, latest) < 0) {
  fail(
    `${version} is older than the published latest (${latest})`,
    'refusing to move the `latest` dist-tag backwards — publish a higher version',
  );
}

console.log(`[publish] v${version} → ${registry}${dryRun ? ' (dry run)' : ''}`);

const published = [];
const skipped = [];
for (const pkg of packages) {
  if (registryState(pkg.name, pkg.version) === 'present') {
    console.log(`[publish] skip ${pkg.name}@${pkg.version} — already on the registry`);
    skipped.push(pkg.name);
    continue;
  }
  console.log(`[publish] ${dryRun ? 'would publish' : 'publish'} ${pkg.name}@${pkg.version}`);
  publish(pkg.rel, pkg);
  published.push(pkg.name);
}

console.log(
  `\n[publish] done: ${published.length} ${dryRun ? 'would publish' : 'published'}` +
    `${published.length ? ` (${published.join(', ')})` : ''}, ` +
    `${skipped.length} already present${skipped.length ? ` (${skipped.join(', ')})` : ''}`,
);
