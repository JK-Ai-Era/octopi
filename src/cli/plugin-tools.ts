/**
 * Plugin tooling (P6-5): `octopi plugin doctor` checks and `octopi plugin
 * sync` deployment. Pure, testable core — CLI glue lives in commands.ts.
 * Deliberately out of scope (v1): dev-mode watch / hot reload; sync reports
 * that a gateway restart is required instead.
 *
 * "Atomic" here means rename-atomicity of the slot swap with rollback: the
 * deployed directory is either the old copy or the new one, never a partial
 * mix, and a failed rollback preserves the backup on disk. It is NOT
 * crash-durable (no fsync) — a kill between the two renames can leave the
 * slot temporarily empty until the next sync sweeps and re-deploys.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { getOctopiHome } from '@octopi-agent/engine/paths.js';
import { parseManifest, validateManifest, type PluginManifest } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/manifest.js';
import { resolvePluginEntry } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/loader.js';
import { getEngineVersion, satisfiesEngineRange } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/engine-compatibility.js';

export interface PluginFinding {
  /** Stable finding id (PLG0xx). */
  id: string;
  severity: 'error' | 'warn' | 'info' | 'ok';
  message: string;
}

export interface PluginDoctorResult {
  /** Parsed manifest id (absent when the manifest is unreadable/invalid). */
  id?: string;
  findings: PluginFinding[];
  /** Whether the plugin has no error-severity findings. */
  healthy: boolean;
}

export interface PluginSyncResult {
  id: string;
  targetDir: string;
  /** Relative paths whose content differs (or that are new) after sync. */
  changedFiles: string[];
  /** Restart notice — in-process plugins have no hot reload in v1. */
  restartRequired: string;
}

/** Dev-only entries that never belong to a deployed plugin copy. */
const DEV_DIRS = new Set(['.git', 'node_modules']);
/** Dev-only file patterns (test files) that never belong to a deployed copy. */
const DEV_FILE = /\.test\.[cm]?[jt]s$/;
/** Staging/backup dirs created by sync itself (swept, never deployed). */
const SYNC_SCRATCH_PREFIXES = ['.sync-tmp-', '.sync-old-'];

export interface PluginFileInventory {
  /** Real files, relative paths sorted. Symlinks to files inside the root are included by content. */
  files: string[];
  /** Symlinked entries and whether they escape the plugin root. */
  symlinks: Array<{ rel: string; escapes: boolean }>;
}

/**
 * Inventory of a plugin directory's deployable files.
 *
 * @param rootDir - Plugin directory
 * @returns Files plus symlink report (symlinks are never silently dropped)
 */
export function collectPluginFiles(rootDir: string): PluginFileInventory {
  const root = realpathSync(rootDir);
  const files: string[] = [];
  const symlinks: PluginFileInventory['symlinks'] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (DEV_DIRS.has(entry.name) || DEV_FILE.test(entry.name)) continue;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (entry.isSymbolicLink()) {
        let escapes = true;
        try {
          const real = realpathSync(abs);
          const relToRoot = relative(root, real);
          escapes = relToRoot === '..' || relToRoot.startsWith(`..${sep}`) || resolve(real) === root;
          if (!escapes && statSync(abs).isFile()) files.push(rel);
        } catch {
          escapes = true; // dangling or unreadable
        }
        symlinks.push({ rel, escapes });
        continue;
      }
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) files.push(rel);
    }
  };
  walk(root);
  return { files: files.sort(), symlinks };
}


/** Deployable files (relative paths, sorted). Symlink handling is `collectPluginFiles`'s. */
export function listPluginFiles(rootDir: string): string[] {
  return collectPluginFiles(rootDir).files;
}

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Compare a source plugin directory against a deployed copy.
 *
 * @param sourceDir - Development/source plugin directory
 * @param deployedDir - Installed copy (e.g. OCTOPI_HOME/plugins/<id>)
 * @returns Relative paths that are new, changed or missing in the deployment
 */
export function diffPluginCopy(sourceDir: string, deployedDir: string): string[] {
  const src = new Set(collectPluginFiles(sourceDir).files);
  const deployed = new Set(collectPluginFiles(deployedDir).files);
  const drifted: string[] = [];
  for (const rel of src) {
    const inDeployed = join(deployedDir, rel);
    if (!deployed.has(rel)) drifted.push(rel);
    else if (fileDigest(join(sourceDir, rel)) !== fileDigest(inDeployed)) drifted.push(rel);
  }
  for (const rel of deployed) {
    if (!src.has(rel)) drifted.push(rel);
  }
  return drifted.sort();
}

/** State files use their own walk: any name is legitimate, and dirs count too. */
function stateDirFindings(pluginId: string): PluginFinding[] {
  const dir = join(getOctopiHome(), 'plugin-state', pluginId);
  const findings: PluginFinding[] = [];
  if (!existsSync(dir)) {
    findings.push({ id: 'PLG005', severity: 'info', message: `plugin-state/${pluginId} not created yet (lazy, 0700 on first use)` });
    return findings;
  }
  const modeOf = (path: string): number => statSync(path).mode & 0o777;
  const loose = (path: string, mode: number): boolean => (mode & 0o077) !== 0;
  const rootMode = modeOf(dir);
  findings.push(
    loose(dir, rootMode)
      ? { id: 'PLG005', severity: 'warn', message: `plugin-state/${pluginId} is mode ${rootMode.toString(8)}; must not be group/other-accessible (api.ensureStateDir() enforces 0700 on next use)` }
      : { id: 'PLG005', severity: 'ok', message: `plugin-state/${pluginId} is not group/other-accessible (mode ${rootMode.toString(8)})` },
  );
  const walk = (sub: string): void => {
    for (const entry of readdirSync(sub, { withFileTypes: true })) {
      const abs = join(sub, entry.name);
      const rel = relative(dir, abs);
      const mode = modeOf(abs);
      if (loose(abs, mode)) {
        findings.push({
          id: 'PLG005',
          severity: 'warn',
          message: `state ${entry.isDirectory() ? 'directory' : 'file'} ${rel} is mode ${mode.toString(8)}; must not be group/other-accessible`,
        });
      }
      if (entry.isDirectory()) walk(abs);
    }
  };
  walk(dir);
  return findings;
}

/**
 * Find a deployed copy of a plugin by manifest id under the plugins root,
 * regardless of the directory name (hand-copied deployments may use any
 * directory name). Falls back to `<root>/<id>` semantics when nothing matches.
 *
 * @param pluginsRoot - Deployment root (e.g. OCTOPI_HOME/plugins)
 * @param id - Manifest id
 * @returns The deployed directory, or null when no copy carries that id
 */
export function findDeployedCopy(pluginsRoot: string, id: string): string | null {
  const exact = join(pluginsRoot, id);
  if (existsSync(join(exact, 'octopi.plugin.json'))) return exact;
  if (!existsSync(pluginsRoot)) return null;
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(pluginsRoot, entry.name);
    try {
      const manifest = parseManifest(readFileSync(join(dir, 'octopi.plugin.json'), 'utf8'));
      if (manifest.id === id) return dir;
    } catch {
      continue; // not a plugin dir (or unreadable) — discovery is best-effort here
    }
  }
  return null;
}

/**
 * Inspect one plugin directory: manifest schema, engine compatibility, entry
 * resolution (the loader's own root-escape rule), state-dir permissions and
 * deployment-copy drift. Scope note: runtime policy (allow/block lists,
 * entries.<id>.enabled, contribution conflicts) is evaluated by the loader at
 * discovery time and is NOT part of this check.
 *
 * @param sourceDir - Plugin directory (contains octopi.plugin.json)
 * @param opts.deployedDir - Optional installed copy to diff against
 * @returns Findings (error severity means the plugin will not load)
 */
export function doctorPlugin(sourceDir: string, opts?: { deployedDir?: string }): PluginDoctorResult {
  const findings: PluginFinding[] = [];
  const manifestPath = join(sourceDir, 'octopi.plugin.json');

  if (!existsSync(manifestPath)) {
    findings.push({ id: 'PLG001', severity: 'error', message: `octopi.plugin.json not found in ${sourceDir}` });
    return { findings, healthy: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    findings.push({ id: 'PLG001', severity: 'error', message: `octopi.plugin.json is not valid JSON: ${String(error)}` });
    return { findings, healthy: false };
  }
  findings.push({ id: 'PLG001', severity: 'ok', message: 'octopi.plugin.json parsed' });

  let manifest: PluginManifest;
  try {
    manifest = validateManifest(raw);
    findings.push({ id: 'PLG002', severity: 'ok', message: `manifest schema valid (id ${manifest.id})` });
  } catch (error) {
    findings.push({ id: 'PLG002', severity: 'error', message: `manifest schema invalid: ${error instanceof Error ? error.message : String(error)}` });
    return { findings, healthy: false };
  }

  const engineVersion = getEngineVersion();
  if (satisfiesEngineRange(engineVersion, manifest.engine.octopi)) {
    findings.push({ id: 'PLG003', severity: 'ok', message: `engine ${engineVersion} satisfies ${manifest.engine.octopi}` });
  } else {
    findings.push({ id: 'PLG003', severity: 'error', message: `requires Octopi ${manifest.engine.octopi}; host is ${engineVersion} — the loader will refuse this plugin` });
  }

  try {
    resolvePluginEntry(sourceDir, manifest.entry);
    findings.push({ id: 'PLG004', severity: 'ok', message: `entry ${manifest.entry} resolves inside the plugin root` });
  } catch (error) {
    findings.push({ id: 'PLG004', severity: 'error', message: `${error instanceof Error ? error.message : String(error)} — the loader will refuse this plugin` });
  }

  findings.push(...stateDirFindings(manifest.id));

  if (manifest.secretOptions && manifest.secretOptions.length > 0) {
    const schema = manifest.configSchema as { properties?: Record<string, unknown> } | undefined;
    const declared = schema?.properties;
    if (!declared) {
      findings.push({ id: 'PLG007', severity: 'info', message: `secretOptions declared (${manifest.secretOptions.join(', ')}); cannot compare — configSchema declares no top-level properties` });
    } else {
      const orphans = manifest.secretOptions.filter((key) => !Object.hasOwn(declared, key));
      findings.push(
        orphans.length > 0
          ? { id: 'PLG007', severity: 'warn', message: `secretOptions keys not present in configSchema.properties: ${orphans.join(', ')} (echo redaction applies, but the schema does not declare them)` }
          : { id: 'PLG007', severity: 'ok', message: `secretOptions declared: ${manifest.secretOptions.join(', ')}` },
      );
    }
  }

  const inventory = collectPluginFiles(sourceDir);
  for (const link of inventory.symlinks) {
    findings.push(
      link.escapes
        ? { id: 'PLG008', severity: 'error', message: `symlink ${link.rel} escapes the plugin root (or is dangling) — sync refuses to deploy it` }
        : { id: 'PLG008', severity: 'warn', message: `symlink ${link.rel} is deployed by content (copied, not linked)` },
    );
  }

  if (opts?.deployedDir && existsSync(opts.deployedDir)) {
    try {
      if (!statSync(opts.deployedDir).isDirectory()) {
        findings.push({ id: 'PLG006', severity: 'error', message: `deployed path ${opts.deployedDir} exists but is not a directory` });
      } else if (realpathSync(opts.deployedDir) === realpathSync(sourceDir)) {
        findings.push({ id: 'PLG006', severity: 'info', message: 'checking the deployed copy itself — no source/deployment drift to compare' });
      } else {
        const drifted = diffPluginCopy(sourceDir, opts.deployedDir);
        findings.push(
          drifted.length === 0
            ? { id: 'PLG006', severity: 'ok', message: 'deployed copy matches source' }
            : { id: 'PLG006', severity: 'warn', message: `deployed copy drifted from source (${drifted.length} file(s)): ${drifted.slice(0, 5).join(', ')}${drifted.length > 5 ? ', …' : ''} — run "octopi plugin sync" to update` },
        );
      }
    } catch (error) {
      findings.push({ id: 'PLG006', severity: 'error', message: `deployed copy could not be compared: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  return { id: manifest.id, findings, healthy: findings.every((f) => f.severity !== 'error') };
}

/**
 * Swap the staged directory into the target slot with rollback. On swap
 * failure the previous copy is restored; if THAT fails, the backup is left on
 * disk (never deleted) and the error reports its path — the previous copy is
 * the only remaining copy in that case and must survive.
 *
 * @param staging - Fully staged new copy beside the target (same filesystem)
 * @param targetDir - Deployed slot
 * @param backup - Scratch path for the displaced copy
 * @param rename - Rename implementation (injectable for failure tests)
 */
export function swapIn(
  staging: string,
  targetDir: string,
  backup: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  const hadTarget = existsSync(targetDir);
  if (hadTarget) rename(targetDir, backup);
  try {
    rename(staging, targetDir);
  } catch (error) {
    if (hadTarget) {
      try {
        rename(backup, targetDir);
      } catch (rollbackError) {
        throw new Error(
          `plugin sync: swap failed (${error instanceof Error ? error.message : String(error)}) and rollback also failed ` +
            `(${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}); ` +
            `the previous copy is preserved at ${backup} — restore it manually`,
        );
      }
    }
    throw error;
  }
  if (hadTarget) rmSync(backup, { recursive: true, force: true });
}

/**
 * Deploy a plugin directory into the plugins root. Files are staged beside
 * the target and the slot is swapped with renames (see swapIn — never left
 * half-written; a failed rollback preserves the backup on disk). Stale
 * `.sync-*` scratch dirs from earlier interrupted runs are swept first.
 *
 * @param sourceDir - Plugin directory to deploy
 * @param pluginsRoot - Deployment root (default OCTOPI_HOME/plugins)
 * @param rename - Rename implementation (injectable for failure tests)
 * @returns Sync result incl. the restart notice
 * @throws When the manifest is invalid, the source is the deployment slot, or the swap cannot be completed
 */
export function syncPlugin(sourceDir: string, pluginsRoot?: string, rename?: (from: string, to: string) => void): PluginSyncResult {
  const root = pluginsRoot ?? join(getOctopiHome(), 'plugins');
  const manifestPath = join(sourceDir, 'octopi.plugin.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`plugin sync: octopi.plugin.json not found in ${sourceDir}`);
  }
  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  const targetDir = join(root, manifest.id);

  // Guard: syncing a plugin that already IS the deployed copy would replace
  // the source with its own dev-file-excluded staging (destroying node_modules
  // etc.) — refuse instead.
  let sourceReal: string;
  let targetReal: string | null = null;
  try {
    sourceReal = realpathSync(sourceDir);
    targetReal = existsSync(targetDir) ? realpathSync(targetDir) : null;
  } catch (error) {
    throw new Error(`plugin sync: cannot resolve paths: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (targetReal !== null && sourceReal === targetReal) {
    throw new Error(`plugin sync: source directory is the deployed copy itself (${targetDir}) — sync from your development directory instead`);
  }

  mkdirSync(root, { recursive: true });
  // Sweep scratch dirs left by interrupted runs (they contain manifests and
  // would otherwise be picked up as duplicate-id candidates by the loader).
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (SYNC_SCRATCH_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
      rmSync(join(root, entry.name), { recursive: true, force: true });
    }
  }

  const staging = join(root, `.sync-tmp-${manifest.id}-${process.pid}-${Date.now()}`);
  const backup = join(root, `.sync-old-${manifest.id}-${process.pid}-${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  try {
    const inventory = collectPluginFiles(sourceDir);
    const escaping = inventory.symlinks.filter((s) => s.escapes);
    if (escaping.length > 0) {
      throw new Error(`plugin sync: refusing to deploy symlink(s) escaping the plugin root: ${escaping.map((s) => s.rel).join(', ')}`);
    }
    for (const rel of inventory.files) {
      const dest = join(staging, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(sourceDir, rel), dest); // follows symlinks: content copy
    }

    const changed = existsSync(targetDir) ? diffPluginCopy(staging, targetDir) : [...inventory.files];
    swapIn(staging, targetDir, backup, rename);
    return {
      id: manifest.id,
      targetDir,
      changedFiles: changed,
      restartRequired:
        'Restart the gateway to load the synced plugin (in-process plugins have no hot reload in v1: octopi serve stop && octopi serve start).',
    };
  } finally {
    // Only the staging dir is swept here — `backup` is swapIn's responsibility
    // (deleting it unconditionally is how a failed rollback loses the last copy).
    rmSync(staging, { recursive: true, force: true });
  }
}
