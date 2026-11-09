/**
 * P6-5 plugin tooling: `octopi plugin doctor` checks and `octopi plugin sync`
 * atomic deployment (create-tooling core; CLI glue is covered by these units
 * plus the init scaffold's doctor-green closure).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { doctorPlugin, syncPlugin, diffPluginCopy, listPluginFiles, collectPluginFiles, swapIn, findDeployedCopy, installPluginFromNpm, ensureDependencies, hasRuntimeDependencies, npmInstallArgs, npmPackArgs, resolveScriptConsent } from '../src/cli/plugin-tools.js';
import { resolvePluginEntry } from '../packages/engine/src/harness/extension/plugin-ecosystem/plugins/loader.js';

let root: string;
let octopiHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'octopi-p65-'));
  octopiHome = join(root, 'home');
  mkdirSync(octopiHome, { recursive: true });
  process.env.OCTOPI_HOME = octopiHome;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.OCTOPI_HOME;
});

function writePlugin(dir: string, manifest: Record<string, unknown>, entry = 'export default {};\n'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'octopi.plugin.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'index.mjs'), entry);
}

function goodManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo',
    apiVersion: '1',
    version: '0.1.0',
    name: 'Demo',
    entry: 'index.mjs',
    engine: { octopi: '>=0.105.0' },
    configSchema: { type: 'object', properties: { token: { type: 'string' } } },
    ...overrides,
  };
}

describe('plugin doctor (P6-5)', () => {
  it('reports a healthy plugin with every check ok or info', () => {
    const dir = join(root, 'src-plugin');
    writePlugin(dir, goodManifest());

    const result = doctorPlugin(dir);
    expect(result.healthy).toBe(true);
    const byId = new Map(result.findings.map((f) => [f.id, f]));
    expect(byId.get('PLG001')!.severity).toBe('ok');
    expect(byId.get('PLG002')!.severity).toBe('ok');
    expect(byId.get('PLG003')!.severity).toBe('ok');
    expect(byId.get('PLG004')!.severity).toBe('ok');
    expect(byId.get('PLG005')!.severity).toBe('info'); // state dir is lazy
  });

  it('flags an unreadable manifest as an error', () => {
    const dir = join(root, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'octopi.plugin.json'), '{ not json');

    const result = doctorPlugin(dir);
    expect(result.healthy).toBe(false);
    expect(result.findings[0]).toMatchObject({ id: 'PLG001', severity: 'error' });
  });

  it('flags a schema-invalid manifest and stops before later checks', () => {
    const dir = join(root, 'bad-schema');
    writePlugin(dir, goodManifest({ id: 'Bad Id!' }));

    const result = doctorPlugin(dir);
    expect(result.healthy).toBe(false);
    expect(result.findings.some((f) => f.id === 'PLG002' && f.severity === 'error')).toBe(true);
    expect(result.findings.some((f) => f.id === 'PLG004')).toBe(false);
  });

  it('flags an engine range the host cannot satisfy', () => {
    const dir = join(root, 'future');
    writePlugin(dir, goodManifest({ engine: { octopi: '>=999' } }));

    const result = doctorPlugin(dir);
    expect(result.healthy).toBe(false);
    const finding = result.findings.find((f) => f.id === 'PLG003')!;
    expect(finding.severity).toBe('error');
    expect(finding.message).toMatch(/the loader will refuse/);
  });

  it('flags a missing entry file', () => {
    const dir = join(root, 'no-entry');
    writePlugin(dir, goodManifest({ entry: 'dist/missing.js' }));

    const result = doctorPlugin(dir);
    expect(result.healthy).toBe(false);
    expect(result.findings.some((f) => f.id === 'PLG004' && f.severity === 'error')).toBe(true);
  });

  it('warns when the state directory is not 0700 and ok when it is', () => {
    const dir = join(root, 'perm');
    writePlugin(dir, goodManifest());
    const stateDir = join(octopiHome, 'plugin-state', 'demo');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o755);

    let result = doctorPlugin(dir);
    expect(result.findings.find((f) => f.id === 'PLG005')!.severity).toBe('warn');
    expect(result.healthy).toBe(true); // warn does not block loading

    chmodSync(stateDir, 0o700);
    result = doctorPlugin(dir);
    expect(result.findings.find((f) => f.id === 'PLG005')!.severity).toBe('ok');
  });

  it('reports deployed-copy drift and clears it after sync', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());
    const deployed = join(octopiHome, 'plugins', 'demo');
    syncPlugin(src);
    // Drift: change one deployed file, add another.
    writeFileSync(join(deployed, 'index.mjs'), 'export default { drifted: true };\n');

    let result = doctorPlugin(src, { deployedDir: deployed });
    const drift = result.findings.find((f) => f.id === 'PLG006')!;
    expect(drift.severity).toBe('warn');
    expect(drift.message).toContain('index.mjs');
    expect(drift.message).toContain('octopi plugin sync');

    syncPlugin(src);
    result = doctorPlugin(src, { deployedDir: deployed });
    expect(result.findings.find((f) => f.id === 'PLG006')!.severity).toBe('ok');
  });

  it('warns when secretOptions keys are absent from configSchema.properties', () => {
    const dir = join(root, 'secrets');
    writePlugin(dir, goodManifest({ secretOptions: ['token', 'orphan'] }));

    const result = doctorPlugin(dir);
    const finding = result.findings.find((f) => f.id === 'PLG007')!;
    expect(finding.severity).toBe('warn');
    expect(finding.message).toContain('orphan');
    expect(finding.message).not.toContain('token,');
  });
});

describe('plugin sync (P6-5)', () => {
  it('deploys a new plugin and prints the restart notice', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());

    const result = syncPlugin(src);
    expect(result.id).toBe('demo');
    expect(result.targetDir).toBe(join(octopiHome, 'plugins', 'demo'));
    expect(result.changedFiles).toEqual(['index.mjs', 'octopi.plugin.json']);
    expect(result.restartRequired).toMatch(/restart the gateway/i);
    expect(result.restartRequired).toMatch(/no hot reload/);
    expect(existsSync(join(result.targetDir, 'octopi.plugin.json'))).toBe(true);
  });

  it('reports only the files that actually changed on re-sync', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());
    syncPlugin(src);

    writeFileSync(join(src, 'index.mjs'), 'export default { v2: true };\n');
    const result = syncPlugin(src);
    expect(result.changedFiles).toEqual(['index.mjs']);
  });

  it('never touches the deployed copy when the manifest is invalid', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());
    syncPlugin(src);
    const deployedManifest = readFileSync(join(octopiHome, 'plugins', 'demo', 'octopi.plugin.json'), 'utf8');

    writePlugin(src, goodManifest({ id: 'bad id' }));
    expect(() => syncPlugin(src)).toThrow();
    // The existing deployment is untouched.
    expect(readFileSync(join(octopiHome, 'plugins', 'demo', 'octopi.plugin.json'), 'utf8')).toBe(deployedManifest);
  });

  it('keeps stale entries out of the deployed copy (file deletion propagates)', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());
    writeFileSync(join(src, 'stale.txt'), 'old');
    syncPlugin(src);
    expect(existsSync(join(octopiHome, 'plugins', 'demo', 'stale.txt'))).toBe(true);

    rmSync(join(src, 'stale.txt'));
    syncPlugin(src);
    expect(existsSync(join(octopiHome, 'plugins', 'demo', 'stale.txt'))).toBe(false);
    expect(diffPluginCopy(src, join(octopiHome, 'plugins', 'demo'))).toEqual([]);
  });

  it('excludes dev-only files from deployment', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());
    writeFileSync(join(src, 'index.test.mjs'), '// test');
    mkdirSync(join(src, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(src, 'node_modules', 'x', 'index.js'), '// dep');

    const result = syncPlugin(src);
    expect(result.changedFiles).toEqual(['index.mjs', 'octopi.plugin.json']);
    expect(listPluginFiles(result.targetDir)).toEqual(['index.mjs', 'octopi.plugin.json']);
  });

  it('swapIn preserves the backup on disk when the rollback itself fails', () => {
    const staging = join(root, 'staging');
    const target = join(root, 'target');
    const backup = join(root, 'backup');
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'f'), 'new');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'f'), 'old');

    // swap succeeds first, then verify the failure path: rename that fails on
    // the swap and on the rollback must leave `backup` untouched on disk.
    let calls = 0;
    const failingRename = (from: string, to: string): void => {
      calls += 1;
      if (calls === 2 || calls === 3) throw new Error(`injected rename failure ${calls}`);
      renameSync(from, to);
    };
    expect(() => swapIn(staging, target, backup, failingRename)).toThrow(/previous copy is preserved at .*backup/);
    expect(existsSync(join(backup, 'f'))).toBe(true);
    expect(readFileSync(join(backup, 'f'), 'utf8')).toBe('old');
  });

  it('swapIn restores the previous copy when only the swap fails', () => {
    const staging = join(root, 'staging');
    const target = join(root, 'target');
    const backup = join(root, 'backup');
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'f'), 'new');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'f'), 'old');

    let calls = 0;
    const failingRename = (from: string, to: string): void => {
      calls += 1;
      if (calls === 2) throw new Error('injected swap failure');
      renameSync(from, to);
    };
    expect(() => swapIn(staging, target, backup, failingRename)).toThrow('injected swap failure');
    expect(readFileSync(join(target, 'f'), 'utf8')).toBe('old'); // restored
  });

  it('refuses to sync a plugin onto its own deployed copy', () => {
    const deployed = join(octopiHome, 'plugins', 'demo');
    writePlugin(deployed, goodManifest());
    writeFileSync(join(deployed, 'notes.test.mjs'), 'dev artifact');

    expect(() => syncPlugin(deployed)).toThrow(/deployed copy itself/);
    // Dev artifacts untouched.
    expect(existsSync(join(deployed, 'notes.test.mjs'))).toBe(true);
  });

  it('preserves stale scratch dirs (no sweep) — a failed rollback backup must survive', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());
    // A backup left by a failed-rollback swap: the error message tells the
    // operator it is preserved there — a later sync must NOT delete it.
    const preserved = join(octopiHome, 'plugins', '.sync-old-demo-1-1');
    mkdirSync(preserved, { recursive: true });
    writeFileSync(join(preserved, 'keep.txt'), 'the only surviving copy');

    syncPlugin(src);
    expect(existsSync(join(preserved, 'keep.txt'))).toBe(true);
    // Doctor points the operator at the leftovers instead of deleting them.
    expect(doctorPlugin(src).findings.find((f) => f.id === 'PLG010')!.message).toMatch(/safe to remove manually/);
  });

  it('refuses to deploy symlinks that escape the plugin root and reports them', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());
    const outside = join(root, 'outside.mjs');
    writeFileSync(outside, 'export default {};');
    symlinkSync(outside, join(src, 'link.mjs'));

    const report = doctorPlugin(src);
    expect(report.healthy).toBe(false);
    expect(report.findings.some((f) => f.id === 'PLG008' && f.severity === 'error')).toBe(true);
    expect(() => syncPlugin(src)).toThrow(/escaping the plugin root/);
  });

  it('includes internal symlinks by content instead of dropping them silently', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());
    writeFileSync(join(src, 'lib-real.mjs'), 'export const x = 1;\n');
    symlinkSync(join(src, 'lib-real.mjs'), join(src, 'lib-link.mjs'));

    const inventory = collectPluginFiles(src);
    expect(inventory.files).toContain('lib-link.mjs');
    expect(inventory.symlinks).toEqual([{ rel: 'lib-link.mjs', escapes: false }]);

    const result = syncPlugin(src);
    expect(existsSync(join(result.targetDir, 'lib-link.mjs'))).toBe(true);
    // And the copy is genuinely complete — no false clean.
    expect(diffPluginCopy(src, result.targetDir)).toEqual([]);
    expect(doctorPlugin(src, { deployedDir: result.targetDir }).findings.some((f) => f.id === 'PLG006' && f.severity === 'ok')).toBe(true);
  });

  it('doctor reports (not throws) when the deployed path is not a directory', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());
    const asFile = join(octopiHome, 'plugins', 'demo');
    mkdirSync(join(octopiHome, 'plugins'), { recursive: true });
    writeFileSync(asFile, 'not a dir');

    const result = doctorPlugin(src, { deployedDir: asFile });
    expect(result.healthy).toBe(false);
    expect(result.findings.find((f) => f.id === 'PLG006')!.message).toMatch(/not a directory/);
  });

  it('entry checks use the loader escape rule (doctor agrees with the loader)', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest({ entry: '../outside.mjs' }));
    writeFileSync(join(root, 'outside.mjs'), 'export default {};');

    const result = doctorPlugin(src);
    expect(result.healthy).toBe(false);
    const entry = result.findings.find((f) => f.id === 'PLG004')!;
    expect(entry.severity).toBe('error');
    expect(entry.message).toMatch(/escapes its root/);
    // The shared primitive is what both sides call.
    expect(() => resolvePluginEntry(src, 'index.mjs')).not.toThrow();
  });

  it('PLG007 is info (not ok) when configSchema declares no properties', () => {
    const dir = join(root, 'narrow');
    writePlugin(dir, goodManifest({ configSchema: { type: 'object' }, secretOptions: ['token'] }));

    const finding = doctorPlugin(dir).findings.find((f) => f.id === 'PLG007')!;
    expect(finding.severity).toBe('info');
    expect(finding.message).toMatch(/cannot compare/);
  });

  it('PLG007 does not treat prototype keys as declared', () => {
    const dir = join(root, 'proto');
    writePlugin(dir, goodManifest({ secretOptions: ['toString'] }));

    const finding = doctorPlugin(dir).findings.find((f) => f.id === 'PLG007')!;
    expect(finding.severity).toBe('warn');
    expect(finding.message).toContain('toString');
  });

  it('PLG005 walks state subdirectories and arbitrary file names', () => {
    const dir = join(root, 'stateful');
    writePlugin(dir, goodManifest());
    const stateDir = join(octopiHome, 'plugin-state', 'demo');
    mkdirSync(join(stateDir, 'cache'), { recursive: true, mode: 0o700 });
    chmodSync(join(stateDir, 'cache'), 0o755);
    writeFileSync(join(stateDir, 'notes.test.ts'), 'x');
    chmodSync(join(stateDir, 'notes.test.ts'), 0o644);

    const findings = doctorPlugin(dir).findings.filter((f) => f.id === 'PLG005' && f.severity === 'warn');
    expect(findings.some((f) => f.message.includes('cache'))).toBe(true);
    expect(findings.some((f) => f.message.includes('notes.test.ts'))).toBe(true);
  });

  it('findDeployedCopy locates a deployment by manifest id regardless of directory name', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());
    // Hand-copied deployment under a directory name that differs from the id.
    const odd = join(octopiHome, 'plugins', 'weixin-clawbot');
    mkdirSync(odd, { recursive: true });
    writeFileSync(join(odd, 'octopi.plugin.json'), JSON.stringify(goodManifest()));
    writeFileSync(join(odd, 'index.mjs'), 'export default { drifted: true };\n');

    expect(findDeployedCopy(join(octopiHome, 'plugins'), 'demo')).toBe(odd);
    expect(findDeployedCopy(join(octopiHome, 'plugins'), 'missing')).toBeNull();

    // Doctor diff now reaches the oddly named copy.
    const result = doctorPlugin(src, { deployedDir: findDeployedCopy(join(octopiHome, 'plugins'), 'demo')! });
    const drift = result.findings.find((f) => f.id === 'PLG006')!;
    expect(drift.severity).toBe('warn');
    expect(drift.message).toContain('index.mjs');
  });

  it('PLG006 is info when the checked directory IS the deployed copy', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());
    const result = doctorPlugin(src, { deployedDir: src });

    const finding = result.findings.find((f) => f.id === 'PLG006')!;
    expect(finding.severity).toBe('info');
    expect(finding.message).toMatch(/deployed copy itself/);
    expect(result.healthy).toBe(true);
  });

  it('a state dir of 0700 survives the doctor round-trip after sync', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());
    syncPlugin(src);
    const stateDir = join(octopiHome, 'plugin-state', 'demo');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    const result = doctorPlugin(src, { deployedDir: join(octopiHome, 'plugins', 'demo') });
    expect(result.healthy).toBe(true);
    expect(result.findings.find((f) => f.id === 'PLG005')!.severity).toBe('ok');
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
  });
});

describe('plugin dependency lifecycle (P6-6)', () => {
  function writePluginWithDeps(dir: string, deps: Record<string, string>, manifestExtra: Record<string, unknown> = {}): void {
    writePlugin(dir, goodManifest(manifestExtra));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '0.1.0', dependencies: deps }, null, 2));
  }

  it('sync installs runtime dependencies in staging before the swap (default, ignore-scripts)', () => {
    const src = join(root, 'src-plugin');
    writePluginWithDeps(src, { 'fake-sdk': '^1.0.0' });
    const calls: Array<{ dir: string; allowScripts: boolean }> = [];

    const result = syncPlugin(src, undefined, undefined, {
      install: (dir, allowScripts) => {
        calls.push({ dir, allowScripts });
        mkdirSync(join(dir, 'node_modules', 'fake-sdk'), { recursive: true });
        writeFileSync(join(dir, 'node_modules', 'fake-sdk', 'package.json'), JSON.stringify({ name: 'fake-sdk', version: '1.2.0' }));
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].allowScripts).toBe(false);
    // Installed in staging (not in the source) and deployed with the swap.
    expect(calls[0].dir).not.toBe(src);
    expect(existsSync(join(result.targetDir, 'node_modules', 'fake-sdk', 'package.json'))).toBe(true);
  });

  it('dependency-free plugins skip installation and --skip-install opts out', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());
    let calls = 0;
    syncPlugin(src, undefined, undefined, { install: () => { calls += 1; } });
    expect(calls).toBe(0);

    const withDeps = join(root, 'with-deps');
    writePluginWithDeps(withDeps, { 'fake-sdk': '^1.0.0' });
    syncPlugin(withDeps, undefined, undefined, { skipInstall: true, install: () => { calls += 1; } });
    expect(calls).toBe(0);
  });

  it('installScripts is a requirement declaration — the OPERATOR consents (never the package)', () => {
    const src = join(root, 'src-plugin');
    writePluginWithDeps(src, { 'native-mod': '^1.0.0' }, { installScripts: true });

    // Without consent: deployment is refused (a skipped postinstall would be a
    // silently broken plugin) — the package cannot self-authorize.
    expect(() => syncPlugin(src, undefined, undefined, { install: () => {} })).toThrow(/declares installScripts/);
    expect(() => syncPlugin(src, undefined, undefined, { install: () => {}, skipInstall: true })).not.toThrow();

    // With operator consent: scripts run.
    let allow: boolean | undefined;
    syncPlugin(src, undefined, undefined, { install: (_dir, allowScripts) => { allow = allowScripts; }, allowScripts: true });
    expect(allow).toBe(true);
  });

  it('npm argv builders are security anchors (scripts never run without consent)', () => {
    expect(npmInstallArgs(false)).toContain('--ignore-scripts');
    expect(npmInstallArgs(true)).not.toContain('--ignore-scripts');
    expect(npmInstallArgs(false)).toContain('--omit=dev');
    // The fetch stage always skips publisher scripts (pack/prepare surface).
    expect(npmPackArgs('x', '/tmp/y')).toContain('--ignore-scripts');
    expect(npmPackArgs('x', '/tmp/y')).not.toContain('--silent');
    expect(npmPackArgs('x', '/tmp/y')).toContain('--loglevel=error');

    const manifest = { id: 'p', apiVersion: '1', version: '1.0.0', name: 'p', entry: 'index.mjs', engine: { octopi: '>=0' }, configSchema: { type: 'object' }, installScripts: true };
    expect(() => resolveScriptConsent(manifest as never, false)).toThrow(/--allow-scripts/);
    expect(resolveScriptConsent(manifest as never, true)).toBe(true);
  });

  it('a failing dependency install leaves the previous deployment untouched', () => {
    const src = join(root, 'src-plugin');
    writePluginWithDeps(src, { 'fake-sdk': '^1.0.0' });
    syncPlugin(src, undefined, undefined, { install: () => {} }); // initial deploy
    const deployed = join(octopiHome, 'plugins', 'demo');
    writeFileSync(join(src, 'index.mjs'), 'export default { v2: true };\n');
    // Change the dependency set — otherwise the unchanged-deps fast path
    // reuses the deployed node_modules and never runs the installer.
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'demo', version: '0.1.0', dependencies: { 'fake-sdk': '^1.0.0', 'extra': '^2.0.0' } }, null, 2));

    expect(() =>
      syncPlugin(src, undefined, undefined, {
        install: () => {
          throw new Error('injected npm failure');
        },
      }),
    ).toThrow(/injected npm failure/);
    // Old deployment intact (initial content, not v2), staging swept.
    expect(readFileSync(join(deployed, 'index.mjs'), 'utf8')).not.toContain('v2');
    expect(readdirSync(join(octopiHome, 'plugins')).filter((e) => e.startsWith('.sync-'))).toEqual([]);
  });

  it('PLG009 reports missing and version-mismatched runtime dependencies as errors', () => {
    const src = join(root, 'src-plugin');
    writePluginWithDeps(src, { 'fake-sdk': '^1.0.0', 'other': '~2.0.0' });

    let result = doctorPlugin(src);
    let finding = result.findings.find((f) => f.id === 'PLG009')!;
    expect(finding.severity).toBe('error');
    expect(finding.message).toContain('fake-sdk');
    expect(finding.message).toContain('other');
    expect(result.healthy).toBe(false);

    mkdirSync(join(src, 'node_modules', 'fake-sdk'), { recursive: true });
    writeFileSync(join(src, 'node_modules', 'fake-sdk', 'package.json'), JSON.stringify({ version: '1.2.0' }));
    mkdirSync(join(src, 'node_modules', 'other'), { recursive: true });
    writeFileSync(join(src, 'node_modules', 'other', 'package.json'), JSON.stringify({ version: '2.5.0' }));

    result = doctorPlugin(src);
    finding = result.findings.find((f) => f.id === 'PLG009')!;
    expect(finding.severity).toBe('error'); // 2.5.0 ∉ ~2.0.0
    expect(finding.message).toContain('other 2.5.0');

    writeFileSync(join(src, 'node_modules', 'other', 'package.json'), JSON.stringify({ version: '2.0.7' }));
    result = doctorPlugin(src);
    expect(result.findings.find((f) => f.id === 'PLG009')!.severity).toBe('ok');
  });

  it('hasRuntimeDependencies distinguishes dependency-free plugins', () => {
    const bare = join(root, 'bare');
    writePlugin(bare, goodManifest());
    expect(hasRuntimeDependencies(bare)).toBe(false);

    const deps = join(root, 'deps');
    writePluginWithDeps(deps, { x: '^1' });
    expect(hasRuntimeDependencies(deps)).toBe(true);
    // ensureDependencies is a no-op for bare plugins even with a throwing runner.
    expect(() => ensureDependencies(bare, { run: () => { throw new Error('must not run'); } })).not.toThrow();
  });

  it('installPluginFromNpm deploys a fetched package and installs its dependencies', () => {
    const calls: Array<{ dir: string; allowScripts: boolean }> = [];
    const result = installPluginFromNpm('@scope/demo', join(octopiHome, 'plugins'), {
      fetch: (_spec, dest) => {
        const content = join(dest, 'content');
        mkdirSync(content, { recursive: true });
        writeFileSync(join(content, 'octopi.plugin.json'), JSON.stringify(goodManifest(), null, 2));
        writeFileSync(join(content, 'index.mjs'), 'export default {};');
        writeFileSync(join(content, 'package.json'), JSON.stringify({ name: 'demo', version: '0.1.0', dependencies: { 'fake-sdk': '^1.0.0' } }));
        return content;
      },
      install: (dir, allowScripts) => {
        calls.push({ dir, allowScripts });
        mkdirSync(join(dir, 'node_modules', 'fake-sdk'), { recursive: true });
        writeFileSync(join(dir, 'node_modules', 'fake-sdk', 'package.json'), JSON.stringify({ version: '1.0.0' }));
      },
    });

    expect(result.id).toBe('demo');
    expect(result.targetDir).toBe(join(octopiHome, 'plugins', 'demo'));
    expect(calls).toHaveLength(1);
    expect(existsSync(join(result.targetDir, 'octopi.plugin.json'))).toBe(true);
    expect(existsSync(join(result.targetDir, 'node_modules', 'fake-sdk'))).toBe(true);
    expect(result.restartRequired).toMatch(/restart the gateway/i);
  });

  it('skip-install preserves the deployed node_modules instead of dropping the closure', () => {
    const src = join(root, 'src-plugin');
    writePluginWithDeps(src, { 'fake-sdk': '^1.0.0' });
    syncPlugin(src, undefined, undefined, {
      install: (dir) => {
        mkdirSync(join(dir, 'node_modules', 'fake-sdk'), { recursive: true });
        writeFileSync(join(dir, 'node_modules', 'fake-sdk', 'package.json'), JSON.stringify({ version: '1.0.0' }));
      },
    });
    const deployed = join(octopiHome, 'plugins', 'demo');
    writeFileSync(join(src, 'index.mjs'), 'export default { v2: true };\n');

    syncPlugin(src, undefined, undefined, { skipInstall: true });
    // The dependency closure survives the file-only update.
    expect(existsSync(join(deployed, 'node_modules', 'fake-sdk', 'package.json'))).toBe(true);
    expect(readFileSync(join(deployed, 'index.mjs'), 'utf8')).toContain('v2');
  });

  it('unchanged dependency set reuses the deployed node_modules (offline fast path)', () => {
    const src = join(root, 'src-plugin');
    writePluginWithDeps(src, { 'fake-sdk': '^1.0.0' });
    let installs = 0;
    const install = (dir: string) => {
      installs += 1;
      mkdirSync(join(dir, 'node_modules', 'fake-sdk'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'fake-sdk', 'package.json'), JSON.stringify({ version: '1.0.0' }));
    };
    syncPlugin(src, undefined, undefined, { install });
    expect(installs).toBe(1);

    writeFileSync(join(src, 'index.mjs'), 'export default { v2: true };\n');
    syncPlugin(src, undefined, undefined, { install });
    expect(installs).toBe(1); // dep set unchanged → node_modules reused, no npm run
    expect(existsSync(join(octopiHome, 'plugins', 'demo', 'node_modules', 'fake-sdk'))).toBe(true);
  });

  it('installPluginFromNpm refuses a plugin the loader would not load (entry/engine)', () => {
    // Missing entry.
    expect(() =>
      installPluginFromNpm('no-entry', join(octopiHome, 'plugins'), {
        fetch: (_spec, dest) => {
          const content = join(dest, 'content');
          mkdirSync(content, { recursive: true });
          writeFileSync(join(content, 'octopi.plugin.json'), JSON.stringify(goodManifest({ entry: 'dist/missing.js' })));
          writeFileSync(join(content, 'package.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }));
          return content;
        },
      }),
    ).toThrow(/not loadable/);
    // Engine range the host cannot satisfy.
    expect(() =>
      installPluginFromNpm('future', join(octopiHome, 'plugins'), {
        fetch: (_spec, dest) => {
          const content = join(dest, 'content');
          mkdirSync(content, { recursive: true });
          writeFileSync(join(content, 'octopi.plugin.json'), JSON.stringify(goodManifest({ engine: { octopi: '>=999' } })));
          writeFileSync(join(content, 'index.mjs'), 'export default {};');
          return content;
        },
      }),
    ).toThrow(/requires Octopi >=999/);
    expect(readdirSync(join(octopiHome, 'plugins')).filter((e) => e.startsWith('.sync-'))).toEqual([]);
  });

  it('PLG009: non-semver specs are presence-only and hoisted deps resolve', () => {
    const src = join(root, 'src-plugin');
    writePluginWithDeps(src, { 'workspace-pkg': 'workspace:*', 'file-pkg': 'file:../shared', 'hoisted-pkg': '^3.0.0' });

    // Hoisted at the workspace root (a parent of sourceDir — Node resolution finds it).
    mkdirSync(join(root, 'node_modules', 'hoisted-pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'hoisted-pkg', 'package.json'), JSON.stringify({ version: '3.1.0' }));
    // Non-semver specs are installed too (npm links them) — presence checked,
    // version not comparable.
    for (const name of ['workspace-pkg', 'file-pkg']) {
      mkdirSync(join(src, 'node_modules', name), { recursive: true });
      writeFileSync(join(src, 'node_modules', name, 'package.json'), JSON.stringify({ version: '0.0.0' }));
    }

    const result = doctorPlugin(src);
    const finding = result.findings.find((f) => f.id === 'PLG009')!;
    expect(finding.severity).toBe('info'); // two non-verifiable, one hoisted-ok → no lie, no false error
    expect(finding.message).toContain('workspace-pkg');
    expect(finding.message).toContain('file-pkg');
  });

  it('a corrupt package.json is a real error, not "nothing to install"', () => {
    const src = join(root, 'src-plugin');
    writePlugin(src, goodManifest());
    writeFileSync(join(src, 'package.json'), '{ not json');
    expect(() => hasRuntimeDependencies(src)).toThrow();
  });

  it('installPluginFromNpm rejects a package that is not a valid plugin', () => {
    expect(() =>
      installPluginFromNpm('not-a-plugin', join(octopiHome, 'plugins'), {
        fetch: (_spec, dest) => {
          const content = join(dest, 'content');
          mkdirSync(content, { recursive: true });
          writeFileSync(join(content, 'package.json'), JSON.stringify({ name: 'nope', version: '1.0.0' }));
          return content;
        },
      }),
    ).toThrow(/octopi.plugin.json not found/);
    expect(readdirSync(join(octopiHome, 'plugins')).filter((e) => e.startsWith('.sync-'))).toEqual([]);
  });
});
