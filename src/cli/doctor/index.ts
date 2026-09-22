/**
 * doctor 检测与修复（本地确定性，零 LLM）
 *
 * @module
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import type { CliArgs } from '../args.js';
import { getOctopiHome } from '../../init.js';
import { validateConfig } from '../../config-schema.js';
import {
  applyConfigMigrations,
  detectConfigMigrations,
  expandEnvPlaceholders,
  parseConfigJson,
} from '../../config-migrations.js';
import type { MigrationFinding } from '../../config-migrations.js';
import {
  applyDataLayerFixes,
  checkDeprecatedSessionStore,
  detectDataLayer,
  resolveAgentDataTargets,
} from './data.js';
import type { AgentDataTarget } from './data.js';
import {
  latestConfigBackup,
  listConfigBackups,
  restoreConfigFromBackup,
} from './restore.js';
import { redactConfig, looksLikeSecret, redactSecretString } from './redact.js';

// ── 类型 ──

export type DoctorSeverity = 'error' | 'warn' | 'info' | 'ok';
export type FixGroup = 'config' | 'layout' | 'data';

export interface DoctorFinding {
  id: string;
  domain: 'config' | 'layout' | 'data' | 'runtime';
  severity: DoctorSeverity;
  message: string;
  hint?: string;
  fixable: boolean;
  /** 可修复时所属分组（交互式勾选用） */
  group?: FixGroup;
}

export interface DoctorReport {
  home: string;
  configPath: string | null;
  findings: DoctorFinding[];
  summary: { error: number; warn: number; info: number; ok: number };
  fixableCount: number;
  backups?: string[];
}

export interface FixCandidateGroup {
  group: FixGroup;
  items: Array<{ id: string; message: string }>;
}

export type SelectFixGroups = (candidates: FixCandidateGroup[]) => Promise<FixGroup[]> | FixGroup[];

export interface DoctorOptions {
  fix?: boolean;
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
  only?: string[];
  allowDeleteLegacyDirs?: boolean;
  /** 强制/关闭交互式勾选；缺省时：TTY 且 --fix 且无 --yes → 交互 */
  interactive?: boolean;
  /** 注入选择器（测试）；返回空数组 = 取消修复 */
  selectFixGroups?: SelectFixGroups;
  /** 仅应用这些分组；设置后跳过交互 */
  selectedGroups?: FixGroup[];
}

// ── 路径解析 ──

/**
 * 解析 doctor 检查的配置路径（显式 -c 最优先）
 *
 * @param args - CLI 参数
 * @returns home 与 config 路径信息
 */
export function resolveDoctorPaths(args: Pick<CliArgs, 'config'>): {
  home: string;
  configPath: string | null;
  cwdConfig: string;
  homeConfig: string;
} {
  const home = getOctopiHome();
  const homeConfig = join(home, 'octopi.json');
  const cwdConfig = resolve(process.cwd(), 'octopi.json');
  if (args.config) {
    const configPath = resolve(args.config);
    return { home, configPath, cwdConfig, homeConfig };
  }
  if (existsSync(homeConfig)) {
    return { home, configPath: homeConfig, cwdConfig, homeConfig };
  }
  if (existsSync(cwdConfig)) {
    return { home, configPath: cwdConfig, cwdConfig, homeConfig };
  }
  return { home, configPath: null, cwdConfig, homeConfig };
}

function migrationToFinding(m: MigrationFinding): DoctorFinding {
  return {
    id: m.id,
    domain: 'config',
    severity: m.severity,
    message: m.message,
    hint: m.hint,
    fixable: m.autoFixable,
    group: m.autoFixable ? 'config' : undefined,
  };
}

/**
 * 将 fixable findings 按分组聚合
 *
 * @param findings - 诊断结果
 * @returns 可修复分组
 */
export function groupFixableFindings(findings: DoctorFinding[]): FixCandidateGroup[] {
  const map = new Map<FixGroup, FixCandidateGroup>();
  for (const f of findings) {
    if (!f.fixable || !f.group) continue;
    let entry = map.get(f.group);
    if (!entry) {
      entry = { group: f.group, items: [] };
      map.set(f.group, entry);
    }
    entry.items.push({ id: f.id, message: f.message });
  }
  return [...map.values()];
}

// ── 布局检测 ──

const LEGACY_PERSONA_MOVES = [
  { from: 'SOUL.md', to: 'persona/10-soul.md' },
  { from: 'IDENTITY.md', to: 'persona/20-identity.md' },
  { from: 'USER.md', to: 'persona/30-user.md' },
  { from: 'TOOLS.md', to: 'persona/40-tools.md' },
];

const LEGACY_AGENT_DIRS = ['memory', 'wisdom', 'extract'];

function checkLayout(
  home: string,
  configPath: string | null,
  raw: Record<string, unknown> | null,
  allowDeleteLegacyDirs: boolean,
  explicitConfig: boolean,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  if (!existsSync(join(home, 'octopi.json')) && !configPath) {
    findings.push({
      id: 'FS001',
      domain: 'layout',
      severity: 'error',
      message: `Octopi home not initialized: ${home}`,
      hint: 'run octopi init (layout fix does not create octopi.json)',
      fixable: false,
    });
  }

  if (configPath && !explicitConfig) {
    const cwdConfig = resolve(process.cwd(), 'octopi.json');
    const homeConfig = join(home, 'octopi.json');
    if (
      resolve(configPath) === resolve(homeConfig) &&
      existsSync(cwdConfig) &&
      resolve(cwdConfig) !== resolve(homeConfig)
    ) {
      findings.push({
        id: 'CFG009',
        domain: 'config',
        severity: 'error',
        message: `cwd octopi.json may shadow OCTOPI_HOME config: ${cwdConfig}`,
        hint: 'prefer -c or OCTOPI_HOME; avoid stray workspace configs',
        fixable: false,
      });
    }
  }

  const agents = raw && Array.isArray(raw.agents) ? raw.agents : [];
  for (const agent of agents) {
    if (typeof agent !== 'object' || agent === null) continue;
    const a = agent as Record<string, unknown>;
    const id = typeof a.id === 'string' ? a.id : 'unknown';
    const agentHome =
      typeof a.home === 'string' && a.home
        ? a.home
        : typeof a.persona === 'string'
          ? a.persona
          : join(home, 'agents', id);

    for (const sub of ['skills']) {
      const dir = join(agentHome, sub);
      if (!existsSync(dir)) {
        findings.push({
          id: 'FS002',
          domain: 'layout',
          severity: 'warn',
          message: `agent "${id}" missing ${sub}/ under ${agentHome}`,
          fixable: true,
          group: 'layout',
        });
      }
    }

    for (const { from, to } of LEGACY_PERSONA_MOVES) {
      const fromPath = join(agentHome, from);
      const toPath = join(agentHome, to);
      if (existsSync(fromPath) && !existsSync(toPath)) {
        findings.push({
          id: 'FS003',
          domain: 'layout',
          severity: 'warn',
          message: `agent "${id}": legacy persona file ${from}`,
          hint: `move to ${to}`,
          fixable: true,
          group: 'layout',
        });
      }
    }

    for (const legacy of LEGACY_AGENT_DIRS) {
      const dir = join(agentHome, legacy);
      if (existsSync(dir)) {
        findings.push({
          id: 'FS004',
          domain: 'layout',
          severity: 'info',
          message: `agent "${id}": obsolete directory ${legacy}/ (memory lives in agent.db)`,
          hint: allowDeleteLegacyDirs
            ? 'will rename to *.deprecated with --fix layout'
            : 'safe to archive manually; not auto-deleted without --allow-delete-legacy-dirs',
          fixable: allowDeleteLegacyDirs,
          group: allowDeleteLegacyDirs ? 'layout' : undefined,
        });
      }
    }
  }

  if (raw && typeof raw.plugins === 'object' && raw.plugins !== null) {
    const plugins = raw.plugins as Record<string, unknown>;
    const loadPaths = Array.isArray(plugins.loadPaths) ? plugins.loadPaths : [];
    for (const p of loadPaths) {
      if (typeof p !== 'string') continue;
      if (!existsSync(p)) {
        findings.push({
          id: 'FS005',
          domain: 'layout',
          severity: 'warn',
          message: `plugins.loadPaths entry missing: ${p}`,
          hint: 'create the directory or correct plugins.loadPaths in config (layout fix does not invent plugin roots)',
          fixable: false,
        });
      }
    }
  }

  return findings;
}

// ── Zod / 语义 ──

function checkZod(raw: unknown): DoctorFinding[] {
  const result = validateConfig(raw);
  if (result.success) {
    return [
      {
        id: 'ZOD000',
        domain: 'config',
        severity: 'ok',
        message: 'HarnessConfigSchema validation passed',
        fixable: false,
      },
    ];
  }
  return (result.errors ?? []).map((e) => ({
    id: 'ZOD001',
    domain: 'config' as const,
    severity: 'error' as const,
    message: `${e.path || '(root)'}: ${e.message}`,
    fixable: false,
  }));
}

/**
 * 复检 apiKey 语义（展开后）；只报告 ok/missing
 *
 * @param rawExpanded - env 展开后的配置
 * @returns findings
 */
export function checkApiKeySemantics(rawExpanded: unknown): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  if (typeof rawExpanded !== 'object' || rawExpanded === null) return findings;
  const models = (rawExpanded as Record<string, unknown>).models;
  const providers =
    typeof models === 'object' && models !== null
      ? ((models as Record<string, unknown>).providers as Record<string, unknown> | undefined)
      : undefined;
  if (!providers || typeof providers !== 'object') return findings;

  for (const [name, cfg] of Object.entries(providers)) {
    if (typeof cfg !== 'object' || cfg === null) continue;
    const apiKey = (cfg as Record<string, unknown>).apiKey;
    const api = (cfg as Record<string, unknown>).api;
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      findings.push({
        id: 'CFG008',
        domain: 'config',
        severity: 'ok',
        message: `models.providers.${name}.apiKey: present (redacted)`,
        fixable: false,
      });
    } else if (api === undefined || String(api).includes('openai') || String(api).includes('anthropic')) {
      findings.push({
        id: 'CFG008',
        domain: 'config',
        severity: 'warn',
        message: `models.providers.${name}.apiKey: missing after env expansion`,
        hint: 'set env var or keep "${VAR}" placeholder in config',
        fixable: false,
      });
    }
  }
  return findings;
}

function domainAllowed(id: string, domain: DoctorFinding['domain'], only?: string[]): boolean {
  if (!only || only.length === 0) return true;
  return only.includes(domain) || only.includes(id);
}

interface Diagnosis {
  findings: DoctorFinding[];
  raw: Record<string, unknown> | null;
  parseRecovered: boolean;
  targets: AgentDataTarget[];
}

function diagnoseConfigLayoutData(
  home: string,
  configPath: string | null,
  allowDeleteLegacyDirs: boolean,
  explicitConfig: boolean,
): Diagnosis {
  const findings: DoctorFinding[] = [];
  let rawUnexpanded: Record<string, unknown> | null = null;
  let parseRecovered = false;

  if (!configPath) {
    findings.push({
      id: 'CFG000',
      domain: 'config',
      severity: 'error',
      message: 'octopi.json not found',
      hint: 'run octopi init or pass -c <path>',
      fixable: false,
    });
  } else {
    const text = readFileSync(configPath, 'utf-8');
    const attempt = parseConfigJson(text);
    if (!attempt.ok) {
      findings.push({
        id: 'R001',
        domain: 'config',
        severity: 'error',
        message: `config JSON parse failed: ${attempt.error ?? 'unknown'}`,
        hint: 'fix syntax manually or restore a backup; doctor will not guess content',
        fixable: false,
      });
    } else if (attempt.recovered) {
      parseRecovered = true;
      findings.push({
        id: 'R001',
        domain: 'config',
        severity: 'warn',
        message: 'config JSON recovered (comments/trailing commas)',
        hint: 'will write normalized JSON when applying --fix config',
        fixable: true,
        group: 'config',
      });
    }

    if (attempt.ok && typeof attempt.raw === 'object' && attempt.raw !== null) {
      rawUnexpanded = attempt.raw as Record<string, unknown>;
      for (const m of detectConfigMigrations(rawUnexpanded)) {
        // CFG010 在下方用带路径对照的增强版覆盖，避免重复
        if (m.id === 'CFG010') continue;
        findings.push(migrationToFinding(m));
      }
      findings.push(...checkZod(rawUnexpanded));
      try {
        // 展开后的文本仅用于复检 apiKey 是否可解析；env 值可能破坏 JSON 结构
        findings.push(...checkApiKeySemantics(JSON.parse(expandEnvPlaceholders(text))));
      } catch {
        // 展开 parse 失败（例如 env 含未转义引号）：退回未展开形状做存在性检查，绝不写回展开文本
        findings.push(...checkApiKeySemantics(rawUnexpanded));
      }
    }
  }

  findings.push(
    ...checkLayout(home, configPath, rawUnexpanded, allowDeleteLegacyDirs, explicitConfig),
  );

  const targets = resolveAgentDataTargets(home, rawUnexpanded);
  findings.push(...detectDataLayer(targets));
  if (configPath) {
    findings.push(...checkDeprecatedSessionStore(rawUnexpanded, targets, dirname(resolve(configPath))));
  }

  return { findings, raw: rawUnexpanded, parseRecovered, targets };
}

/**
 * 默认交互式选择器（TTY）
 *
 * @param candidates - 可修复分组
 * @returns 用户选择的分组；取消为空数组
 */
export async function defaultSelectFixGroups(candidates: FixCandidateGroup[]): Promise<FixGroup[]> {
  if (candidates.length === 0) return [];
  console.log('\nFixable groups:');
  candidates.forEach((c, i) => {
    console.log(`  [${i + 1}] ${c.group} — ${c.items.map((it) => it.id).join(', ')}`);
    for (const it of c.items) console.log(`       - ${it.message}`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question('Apply which groups? [a=all / 1,2 / q=cancel]: ')
    ).trim().toLowerCase();
    if (!answer || answer === 'q' || answer === 'n') return [];
    if (answer === 'a' || answer === 'all' || answer === 'y' || answer === 'yes') {
      return candidates.map((c) => c.group);
    }
    const picked = new Set<FixGroup>();
    for (const part of answer.split(/[\s,]+/)) {
      const idx = Number(part) - 1;
      if (Number.isInteger(idx) && candidates[idx]) picked.add(candidates[idx]!.group);
    }
    return [...picked];
  } finally {
    rl.close();
  }
}

/**
 * 执行 doctor 检测（及可选修复）
 *
 * @param args - CLI 参数
 * @param options - doctor 选项
 * @returns 报告
 */
export async function runDoctor(
  args: Pick<CliArgs, 'config'>,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const paths = resolveDoctorPaths(args);
  const explicitConfig = Boolean(args.config);
  const fixFindings: DoctorFinding[] = [];

  let diagnosis = diagnoseConfigLayoutData(
    paths.home,
    paths.configPath,
    Boolean(options.allowDeleteLegacyDirs),
    explicitConfig,
  );

  const backups = paths.configPath && existsSync(paths.configPath) ? listConfigBackups(paths.configPath) : [];

  if (options.fix && !options.dryRun) {
    const candidates = groupFixableFindings(diagnosis.findings);
    const shadowing = diagnosis.findings.some((f) => f.id === 'CFG009');
    let selected: FixGroup[] | null = options.selectedGroups ?? null;
    let refuseReason: string | null = null;

    if (selected === null) {
      if (options.selectFixGroups) {
        selected = await options.selectFixGroups(candidates);
        if (selected.length === 0) {
          fixFindings.push({
            id: 'FIX000',
            domain: 'config',
            severity: 'info',
            message: 'interactive fix cancelled; no changes written',
            fixable: false,
          });
        }
      } else if (shadowing && !args.config) {
        refuseReason =
          'CFG009: cwd octopi.json may shadow OCTOPI_HOME config; pass -c <path> to choose which file to fix';
        selected = [];
      } else if (options.yes) {
        selected = candidates.map((c) => c.group);
      } else if (options.interactive === true || (options.interactive !== false && Boolean(process.stdin.isTTY) && candidates.length > 0)) {
        selected = await defaultSelectFixGroups(candidates);
        if (selected.length === 0) {
          fixFindings.push({
            id: 'FIX000',
            domain: 'config',
            severity: 'info',
            message: 'interactive fix cancelled; no changes written',
            fixable: false,
          });
        }
      } else {
        // 非 TTY 且未显式 --yes：拒绝静默写盘（与 help 中 --yes 契约一致）
        refuseReason =
          'refusing non-interactive --fix without --yes (pass --fix --yes, or run in a TTY for group selection)';
        selected = [];
      }
    } else if (shadowing && !args.config) {
      refuseReason =
        'CFG009: cwd octopi.json may shadow OCTOPI_HOME config; pass -c <path> to choose which file to fix';
      selected = [];
    }

    if (refuseReason) {
      fixFindings.push({
        id: 'FIX000',
        domain: 'config',
        severity: 'warn',
        message: refuseReason,
        hint: 'no changes written',
        fixable: false,
      });
    }

    const applySet = new Set(selected ?? []);
    const applyConfig = applySet.has('config');
    const applyLayout = applySet.has('layout');
    const applyData = applySet.has('data');

    if (applyConfig && paths.configPath && diagnosis.raw) {
      const applied = applyConfigMigrations(diagnosis.raw);
      if (applied.changed || diagnosis.parseRecovered) {
        const backupPath = `${paths.configPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
        writeFileSync(backupPath, readFileSync(paths.configPath, 'utf-8'), 'utf-8');
        writeFileSync(paths.configPath, JSON.stringify(diagnosis.raw, null, 2) + '\n', 'utf-8');
        fixFindings.push({
          id: 'FIX000',
          domain: 'config',
          severity: 'ok',
          message: `config migrations written; backup at ${backupPath}`,
          hint: applied.notes.join('; ') || undefined,
          fixable: false,
        });
      }
    }

    if (applyLayout) {
      const layoutFixed = applyLayoutFixes(paths.home, diagnosis.raw, options);
      if (layoutFixed.length > 0) {
        fixFindings.push({
          id: 'FIX001',
          domain: 'layout',
          severity: 'ok',
          message: `layout fixes: ${layoutFixed.join('; ')}`,
          fixable: false,
        });
      }
    }

    if (applyData) {
      const dataResult = await applyDataLayerFixes(diagnosis.targets, { dryRun: false });
      fixFindings.push(...dataResult.findings);
    }

    diagnosis = diagnoseConfigLayoutData(
      paths.home,
      paths.configPath,
      Boolean(options.allowDeleteLegacyDirs),
      explicitConfig,
    );
  } else if (options.fix && options.dryRun) {
    const candidates = groupFixableFindings(diagnosis.findings);
    const probe = diagnosis.raw ? structuredClone(diagnosis.raw) : null;
    const applied = probe ? applyConfigMigrations(probe) : { notes: [] as string[] };
    const dataDry = await applyDataLayerFixes(diagnosis.targets, { dryRun: true });
    fixFindings.push({
      id: 'FIX000',
      domain: 'config',
      severity: 'info',
      message: `dry-run would apply groups [${candidates.map((c) => c.group).join(', ') || 'none'}]; file not modified`,
      hint: applied.notes.join('; ') || undefined,
      fixable: true,
    });
    fixFindings.push(...dataDry.findings);
  }

  const filtered = diagnosis.findings
    .filter((f) => domainAllowed(f.id, f.domain, options.only))
    .concat(fixFindings);
  filtered.push({
    id: 'RUN001',
    domain: 'runtime',
    severity: 'info',
    message: 'doctor runs locally with deterministic rules only (no LLM; secrets redacted in reports)',
    fixable: false,
  });

  const summary = { error: 0, warn: 0, info: 0, ok: 0 };
  for (const f of filtered) {
    summary[f.severity] += 1;
  }

  const finalBackups =
    paths.configPath && existsSync(paths.configPath) ? listConfigBackups(paths.configPath) : backups;

  return {
    home: paths.home,
    configPath: paths.configPath,
    findings: filtered,
    summary,
    fixableCount: filtered.filter((f) => f.fixable).length,
    backups: finalBackups,
  };
}

/**
 * 应用布局侧修复
 *
 * @param home - OCTOPI_HOME
 * @param raw - 配置对象
 * @param options - doctor 选项
 * @returns 已执行动作说明
 */
export function applyLayoutFixes(
  home: string,
  raw: Record<string, unknown> | null,
  options: DoctorOptions,
): string[] {
  const notes: string[] = [];
  if (options.dryRun) return ['[dry-run] layout fixes skipped'];

  mkdirSync(join(home, 'plugins'), { recursive: true });
  mkdirSync(join(home, 'audit'), { recursive: true });
  mkdirSync(join(home, 'sessions'), { recursive: true });

  const agents = raw && Array.isArray(raw.agents) ? raw.agents : [{ id: 'default' }];
  for (const agent of agents) {
    const a = (typeof agent === 'object' && agent !== null ? agent : {}) as Record<string, unknown>;
    const id = typeof a.id === 'string' && a.id ? a.id : 'default';
    const agentHome =
      typeof a.home === 'string' && a.home
        ? resolve(a.home)
        : typeof a.persona === 'string'
          ? resolve(a.persona)
          : join(home, 'agents', id);

    mkdirSync(agentHome, { recursive: true });
    mkdirSync(join(agentHome, 'skills'), { recursive: true });
    const workspace =
      typeof a.workspace === 'string' && a.workspace ? resolve(a.workspace) : join(home, 'workspace', id);
    mkdirSync(workspace, { recursive: true });

    for (const { from, to } of LEGACY_PERSONA_MOVES) {
      const fromPath = join(agentHome, from);
      const toPath = join(agentHome, to);
      if (existsSync(fromPath) && !existsSync(toPath)) {
        mkdirSync(dirname(toPath), { recursive: true });
        renameSync(fromPath, toPath);
        notes.push(`persona ${from} → ${to} (${id})`);
      }
    }

    if (options.allowDeleteLegacyDirs) {
      for (const legacy of LEGACY_AGENT_DIRS) {
        const dir = join(agentHome, legacy);
        if (existsSync(dir)) {
          const target = `${dir}.deprecated`;
          if (!existsSync(target)) {
            renameSync(dir, target);
            notes.push(`renamed ${legacy}/ → ${legacy}.deprecated/ (${id})`);
          }
        }
      }
    }
  }

  if (notes.length === 0) notes.push('layout already consistent');
  return notes;
}

/**
 * 将报告格式化为人类可读文本（已脱敏）
 *
 * @param report - doctor 报告
 * @returns 展示文本
 */
/**
 * 清洗 finding 文案中的疑似密钥
 *
 * @param text - 原始 message/hint
 * @returns 脱敏后文本
 */
function scrubFindingText(text: string): string {
  if (!looksLikeSecret(text)) return text;
  return text.replace(/sk-[A-Za-z0-9_-]+/g, (m) => redactSecretString(m));
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('🏥 Octopi Doctor');
  lines.push(`   Home:   ${report.home}`);
  lines.push(`   Config: ${report.configPath ?? '(not found)'}`);
  if (report.backups && report.backups.length > 0) {
    lines.push(`   Backups:${report.backups.length} (latest: ${report.backups[0]})`);
  }
  lines.push('');
  const mark: Record<DoctorSeverity, string> = {
    error: '✗',
    warn: '⚠',
    info: 'ℹ',
    ok: '✓',
  };
  for (const f of report.findings) {
    const message = scrubFindingText(f.message);
    const hint = f.hint ? `\n      ${scrubFindingText(f.hint)}` : '';
    const fix = f.fixable ? `  [fixable${f.group ? `:${f.group}` : ''}]` : '';
    lines.push(`${mark[f.severity]} ${f.id} [${f.severity}] ${message}${fix}${hint}`);
  }
  lines.push('');
  lines.push(
    `Summary: ${report.summary.error} error, ${report.summary.warn} warn, ${report.summary.info} info, ${report.summary.ok} ok`,
  );
  if (report.fixableCount > 0) {
    lines.push(`Next:    octopi doctor --fix --yes`);
  }
  return lines.join('\n');
}

/**
 * 报告转 JSON（脱敏）
 *
 * @param report - doctor 报告
 * @returns JSON 字符串
 */
export function doctorReportToJson(report: DoctorReport): string {
  const findings = report.findings.map((f) => ({
    ...f,
    message: scrubFindingText(f.message),
    hint: f.hint ? scrubFindingText(f.hint) : undefined,
  }));
  return JSON.stringify(
    {
      home: report.home,
      configPath: report.configPath,
      summary: report.summary,
      fixableCount: report.fixableCount,
      backups: report.backups ?? [],
      findings,
      redactedNote: 'secret values never emitted; doctor does not call LLMs',
      redacted: redactConfig({ note: 'secret values never emitted; doctor does not call LLMs' }),
    },
    null,
    2,
  );
}

/**
 * 处理 --restore
 *
 * @param args - CLI 参数（restore 可为 true 或备份路径）
 * @returns 是否已处理 restore 模式
 */
export async function doctorRestoreCommand(args: CliArgs): Promise<void> {
  const paths = resolveDoctorPaths(args);
  if (!paths.configPath) {
    console.error('octopi doctor --restore: config not found; pass -c <path>');
    process.exitCode = 3;
    return;
  }

  const restoreArg = args.restore;
  let backupPath: string | null = null;
  if (typeof restoreArg === 'string' && restoreArg) {
    backupPath = resolve(restoreArg);
  } else {
    backupPath = latestConfigBackup(paths.configPath);
  }

  if (!backupPath) {
    const listed = listConfigBackups(paths.configPath);
    console.error(`octopi doctor --restore: no backup found for ${paths.configPath}`);
    if (listed.length > 0) {
      console.error('Available backups:');
      for (const p of listed) console.error(`  ${p}`);
    }
    process.exitCode = 3;
    return;
  }

  const result = restoreConfigFromBackup(paths.configPath, backupPath);
  console.log(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
  if (args.json) {
    console.log(JSON.stringify({ redactedNote: 'restore copies local files only; no LLM', ...result }, null, 2));
  }
  process.exitCode = result.ok ? 0 : 3;
}

/**
 * CLI 入口：octopi doctor
 *
 * @param args - CLI 参数
 * @param options - 选项
 */
export async function doctorCommand(args: CliArgs, options: DoctorOptions = {}): Promise<void> {
  if (args.restore) {
    await doctorRestoreCommand(args);
    return;
  }

  const report = await runDoctor(args, {
    ...options,
    selectedGroups: options.selectedGroups,
  });
  if (options.json) {
    console.log(doctorReportToJson(report));
  } else {
    console.log(formatDoctorReport(report));
  }

  if (report.summary.error > 0) {
    process.exitCode = 2;
  } else if (report.summary.warn > 0) {
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

/** 供测试：列出 agent 目录 */
export function listAgentDirs(home: string): string[] {
  const agentsDir = join(home, 'agents');
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((name) => {
      try {
        return statSync(join(agentsDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

export { listConfigBackups, latestConfigBackup, restoreConfigFromBackup };
export {
  detectDataLayer,
  applyDataLayerFixes,
  resolveAgentDataTargets,
  checkDeprecatedSessionStore,
};
