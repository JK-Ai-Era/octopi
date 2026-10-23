/**
 * package_edit / project_run / package_install — package-manager surface
 * without a shell.
 *
 * - package_edit: structured package.json mutation via ToolFileEffects (undo).
 * - project_run: run a named script from package.json#scripts (runner capability;
 *   stripped on reduced surface — it executes workspace code).
 * - package_install: npm/pnpm/yarn install|add|remove. Tagged `egress`; refused
 *   when networkPolicy is not open (prompt the user to install manually).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegisteredTool, ToolExecutionContext } from '@octopi-agent/core/types.js';
import { gateEffect } from '../../execution-environment/effect-policy.js';
import {
  isUnderAttachmentRoot,
  isUnderSessionUndoRoot,
  resolveToolPath,
  findExecutable,
} from './platform.js';
import { runAllowlistedArgv, type AllowlistedRunResult } from './allowlisted-run.js';
import { resolveNodeToolCommand } from './platform.js';

type Pm = 'npm' | 'pnpm' | 'yarn';

function resolveCwd(context: ToolExecutionContext | undefined, raw?: string): string {
  const cwd = raw ?? context?.cwd ?? process.cwd();
  const abs = resolveToolPath(cwd, context?.cwd, {
    allowRoots: context?.pathRoots,
    containment: context?.pathContainment,
  });
  if (isUnderAttachmentRoot(abs, context?.attachmentRoots)) {
    throw new Error('session attachments are read-only; cannot run package tools under attachments root');
  }
  if (isUnderSessionUndoRoot(abs, context?.undoRoots)) {
    throw new Error('session undo ledger is protected; cannot run package tools under sessions undo dir');
  }
  return abs;
}

function assertPathSafe(
  raw: string,
  context: ToolExecutionContext | undefined,
  label: string,
): string {
  const abs = resolveToolPath(raw, context?.cwd, {
    allowRoots: context?.pathRoots,
    containment: context?.pathContainment,
  });
  if (isUnderAttachmentRoot(abs, context?.attachmentRoots)) {
    throw new Error(`session attachments are read-only; cannot ${label} under attachments root`);
  }
  if (isUnderSessionUndoRoot(abs, context?.undoRoots)) {
    throw new Error(`session undo ledger is protected; cannot ${label} under sessions undo dir`);
  }
  return abs;
}

async function readPackageJson(
  pkgPath: string,
): Promise<{ pkg: Record<string, unknown>; raw: string }> {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`package_json_invalid: ${pkgPath} is not a JSON object`);
  }
  return { pkg: parsed as Record<string, unknown>, raw };
}

/**
 * Preserve the file's existing EOL and trailing-newline so package.json does
 * not flip CRLF↔LF when the agent edits it on any OS (git / editors care).
 */
function stringifyPreservingEol(value: unknown, original: string): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const trailingEol = /\r?\n$/.test(original);
  const indentMatch = /\n([\t ]+)"/.exec(original);
  const indent = indentMatch ? indentMatch[1]! : '  ';
  const body = JSON.stringify(value, null, indent);
  const normalized = body.split('\n').join(eol);
  return trailingEol ? normalized + eol : normalized;
}

function getDotted(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeDotted(path: string): string[] {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) throw new Error('package_edit: empty path');
  for (const p of parts) {
    if (FORBIDDEN_KEYS.has(p)) {
      throw new Error(`package_edit_forbidden_key: "${path}" contains a prototype-polluting key`);
    }
  }
  return parts;
}

function setDotted(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = assertSafeDotted(path);
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function deleteDotted(obj: Record<string, unknown>, path: string): boolean {
  const parts = assertSafeDotted(path);
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]!];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
    cur = next as Record<string, unknown>;
  }
  return delete cur[parts[parts.length - 1]!];
}

/** Detect package manager from lockfile; fall back to npm. */
async function detectPm(cwd: string, explicit?: string): Promise<Pm> {
  if (explicit === 'npm' || explicit === 'pnpm' || explicit === 'yarn') return explicit;
  const { access } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const has = async (f: string) => access(join(cwd, f)).then(() => true, () => false);
  if (await has('pnpm-lock.yaml')) return 'pnpm';
  if (await has('yarn.lock')) return 'yarn';
  return 'npm';
}

function pmCommand(pm: Pm): { executable: string; prefixArgs: string[] } {
  return resolveNodeToolCommand(pm);
}

function toText(result: AllowlistedRunResult): Record<string, unknown> {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated,
    terminated: result.terminated,
    terminateReason: result.terminateReason,
    isolation: result.isolation,
  };
}

/** package_edit — structured package.json edit (undoable) */
export function createPackageEditTool(): RegisteredTool {
  return {
    definition: {
      name: 'package_edit',
      capabilities: ['fs-write', 'fs-read'],
      description:
        'Structurally edit package.json (scripts, dependencies, metadata) via dotted paths. Undoable. Prefer this over rewriting the whole file.',
      parameters: {
        path: {
          type: 'string',
          description: 'Path to package.json (default: <cwd>/package.json)',
        },
        set: {
          type: 'object',
          description:
            'Map of dotted path → value, e.g. {"scripts.test":"vitest run","dependencies.lodash":"^4.0.0"}',
        },
        remove: {
          type: 'array',
          description: 'Dotted paths to delete, e.g. ["devDependencies.old"]',
          items: { type: 'string', description: 'Dotted path' },
        },
      },
    },
    // 整文件读改写无合并语义：所在 tool_call 批次整体串行，防同路径并发读改写互相覆盖
    executionMode: 'sequential',
    handler: async (args, context) => {
      const cwd = resolveCwd(context);
      const rawPath = (args.path as string | undefined) ?? 'package.json';
      const pkgPath = assertPathSafe(rawPath, context, 'edit');
      const { pkg, raw: originalText } = await readPackageJson(pkgPath);

      const set = (args.set as Record<string, unknown> | undefined) ?? {};
      const remove = Array.isArray(args.remove) ? (args.remove as string[]) : [];
      const changed: string[] = [];

      for (const [key, value] of Object.entries(set)) {
        setDotted(pkg, key, value);
        changed.push(`set:${key}`);
      }
      for (const key of remove) {
        if (deleteDotted(pkg, key)) changed.push(`remove:${key}`);
      }
      if (changed.length === 0) {
        return { path: pkgPath, changed: [], skipped: 'no set/remove provided' };
      }

      await gateEffect(
        { kind: 'file.write', path: pkgPath, mode: 'edit', transactional: true },
        {
          effects: context?.effectChannel ?? 'engine',
          confirmEffect: context?.confirmEffect,
          sessionId: context?.sessionId,
          agentId: context?.agentId,
        },
      );

      const effects = context?.fileEffects;
      if (!effects) {
        throw new Error('file_effects_not_configured: package_edit requires ToolExecutionContext.fileEffects');
      }
      const after = stringifyPreservingEol(pkg, originalText);
      await effects.writeFile(pkgPath, after);
      return { path: pkgPath, changed, packageManager: await detectPm(cwd) };
    },
  };
}

/** project_run — run a named package.json script (runner; stripped on reduced) */
export function createProjectRunTool(): RegisteredTool {
  return {
    definition: {
      name: 'project_run',
      capabilities: ['runner'],
      description:
        'Run a named script from package.json#scripts (e.g. test, lint, build). Pass the script name only — never an arbitrary command string. Executes workspace code; blocked when the tool surface is reduced.',
      parameters: {
        script: {
          type: 'string',
          description: 'Script name defined in package.json#scripts',
          required: true,
        },
        cwd: { type: 'string', description: 'Project directory (default: workspace cwd)' },
        args: {
          type: 'array',
          description: 'Extra args passed after the script (npm run <script> -- <args>)',
          items: { type: 'string', description: 'Argument' },
        },
        packageManager: {
          type: 'string',
          description: 'Force package manager (default: detect from lockfile)',
          enum: ['npm', 'pnpm', 'yarn'],
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default 300000)',
          minimum: 1000,
          maximum: 1_800_000,
        },
      },
    },
    handler: async (args, context) => {
      const cwd = resolveCwd(context, args.cwd as string | undefined);
      const script = String(args.script ?? '').trim();
      if (!script || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(script)) {
        throw new Error(`project_run: invalid script name "${script}"`);
      }

      const pkgPath = resolveToolPath('package.json', cwd, {
        allowRoots: context?.pathRoots,
        containment: context?.pathContainment,
      });
      const { pkg } = await readPackageJson(pkgPath);
      const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
      if (typeof scripts[script] !== 'string') {
        throw new Error(
          `project_run_unknown_script: "${script}" is not defined in package.json#scripts. Available: ${Object.keys(scripts).join(', ') || '(none)'}`,
        );
      }

      await gateEffect(
        {
          kind: 'runner',
          command: `run ${script}`,
          cwd,
          description: `project script "${script}"`,
        },
        {
          effects: context?.effectChannel ?? 'engine',
          confirmEffect: context?.confirmEffect,
          sessionId: context?.sessionId,
          agentId: context?.agentId,
        },
      );

      const pm = await detectPm(cwd, args.packageManager as string | undefined);
      const extra = Array.isArray(args.args) ? (args.args as string[]).map(String) : [];
      // Script body is defined by the project; we only pass its name as argv.
      const pmArgs = pm === 'yarn' ? ['run', script, ...(extra.length ? ['--', ...extra] : [])] : ['run', script, ...(extra.length ? ['--', ...extra] : [])];
      const { tmpdir } = await import('node:os');
      const result = await runAllowlistedArgv({
        executable: pmCommand(pm).executable,
        args: [...pmCommand(pm).prefixArgs, ...pmArgs],
        cwd,
        context,
        env: {
          npm_config_cache: join(tmpdir(), 'octopi-npm-cache'),
          npm_config_update_notifier: 'false',
        },
        timeoutMs: Number(args.timeout) > 0 ? Math.min(Number(args.timeout), 1_800_000) : 300_000,
        journal: true,
      });
      return { ...toText(result), cwd, script, packageManager: pm, scriptBody: scripts[script] };
    },
  };
}

/** package_install — install/add/remove deps (egress; network-gated) */
export function createPackageInstallTool(): RegisteredTool {
  return {
    definition: {
      name: 'package_install',
      capabilities: ['egress', 'runner'],
      description:
        'Install, add, or remove npm/pnpm/yarn dependencies. Requires open network (egress). When the network is denied, install dependencies manually and re-run.',
      parameters: {
        action: {
          type: 'string',
          description: 'Install action',
          enum: ['install', 'add', 'remove', 'ci'],
          required: true,
        },
        packages: {
          type: 'array',
          description: 'Package names for add/remove (e.g. lodash, vitest@^4)',
          items: { type: 'string', description: 'Package spec' },
        },
        dev: { type: 'boolean', description: 'add as devDependency' },
        cwd: { type: 'string', description: 'Project directory' },
        packageManager: {
          type: 'string',
          description: 'Force package manager (default: detect from lockfile)',
          enum: ['npm', 'pnpm', 'yarn'],
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default 600000)',
          minimum: 1000,
          maximum: 1_800_000,
        },
      },
    },
    handler: async (args, context) => {
      const action = String(args.action ?? '');
      if (!['install', 'add', 'remove', 'ci'].includes(action)) {
        throw new Error(`package_install: unsupported action "${action}"`);
      }
      const cwd = resolveCwd(context, args.cwd as string | undefined);
      const packages = Array.isArray(args.packages) ? (args.packages as string[]).map(String) : [];

      if ((action === 'add' || action === 'remove') && packages.length === 0) {
        throw new Error(`package_install: action=${action} requires packages`);
      }
      for (const p of packages) {
        if (!/^[A-Za-z0-9@][A-Za-z0-9@/._+^~<>=*-]*$/.test(p)) {
          throw new Error(`package_install: invalid package spec "${p}"`);
        }
      }

      // Network gate (D4): workspace/untrusted default deny — refuse before spawn.
      const net = context?.networkPolicy ?? 'deny';
      if (net !== 'open') {
        throw new Error(
          `package_install_network_denied: networkPolicy=${net}. Install dependencies manually (e.g. run npm install on the host), then re-run. package_install only works when networkPolicy=open.`,
        );
      }

      await gateEffect(
        {
          kind: 'runner',
          command: `${action} ${packages.join(' ')}`.trim(),
          cwd,
          description: `package ${action}`,
        },
        {
          effects: context?.effectChannel ?? 'engine',
          confirmEffect: context?.confirmEffect,
          sessionId: context?.sessionId,
          agentId: context?.agentId,
        },
      );

      const pm = await detectPm(cwd, args.packageManager as string | undefined);
      const pmArgs: string[] = [];
      if (action === 'ci') {
        if (pm === 'npm') pmArgs.push('ci');
        else if (pm === 'yarn') pmArgs.push('install', '--frozen-lockfile');
        else pmArgs.push('install', '--frozen-lockfile');
      } else if (action === 'install') {
        pmArgs.push('install');
      } else if (action === 'add') {
        pmArgs.push(pm === 'yarn' ? 'add' : 'add');
        if (args.dev === true) pmArgs.push(pm === 'yarn' ? '--dev' : '--save-dev');
        pmArgs.push(...packages);
      } else {
        pmArgs.push(pm === 'yarn' ? 'remove' : 'uninstall', ...packages);
      }

      const result = await runAllowlistedArgv({
        executable: pmCommand(pm).executable,
        args: [...pmCommand(pm).prefixArgs, ...pmArgs],
        cwd,
        context,
        env: {
          npm_config_cache: join(tmpdir(), 'octopi-npm-cache'),
          npm_config_update_notifier: 'false',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
        },
        timeoutMs: Number(args.timeout) > 0 ? Math.min(Number(args.timeout), 1_800_000) : 600_000,
        journal: true,
      });
      return { ...toText(result), cwd, action, packages, packageManager: pm };
    },
  };
}

/** package_edit + project_run + package_install */
export function createPackageTools(): RegisteredTool[] {
  return [createPackageEditTool(), createProjectRunTool(), createPackageInstallTool()];
}

/** Unused helper kept for future package_ls (P1). */
export function findPackageManagerExecutable(pm: Pm): string | null {
  return findExecutable(pm);
}
