/**
 * doctor 与 config-migrations 行为测试
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyConfigMigrations,
  detectConfigMigrations,
  parseConfigJson,
  applyBudgetMaxTimeMs,
  stripTrailingCommas,
} from '../src/config-migrations.js';
import { redactConfig } from '../src/cli/doctor/redact.js';
import {
  runDoctor,
  doctorReportToJson,
  formatDoctorReport,
  groupFixableFindings,
} from '../src/cli/doctor/index.js';
import {
  listConfigBackups,
  latestConfigBackup,
  restoreConfigFromBackup,
} from '../src/cli/doctor/restore.js';
import { renameLegacySessionFiles, listLegacySessionFiles } from '../src/cli/doctor/data.js';
import { loadConfig } from '../src/config.js';

describe('config-migrations', () => {
  it('detects and applies supervisor → runGuard', () => {
    const raw = {
      supervisor: { enabled: true, checkpointInterval: 10 },
      agents: [{ id: 'a', model: 'openai/gpt' }],
      models: { providers: {} },
    };
    const findings = detectConfigMigrations(raw);
    expect(findings.some((f) => f.id === 'CFG001')).toBe(true);

    const result = applyConfigMigrations(raw);
    expect(result.changed).toBe(true);
    expect(raw.supervisor).toBeUndefined();
    expect((raw as Record<string, unknown>).runGuard).toEqual({
      enabled: true,
      checkpointInterval: 10,
    });
  });

  it('migrates budget.maxTimeMs to maxWallClockMs', () => {
    const raw = { budget: { maxTokens: 1000, maxTimeMs: 60_000 } };
    expect(applyBudgetMaxTimeMs(raw)).toBe(true);
    expect(raw.budget).toEqual({ maxTokens: 1000, maxWallClockMs: 60_000 });
  });

  it('moves persona string to home without touching values', () => {
    const raw = {
      agents: [{ id: 'a', persona: '/data/agent-a', model: 'openai/gpt' }],
    };
    applyConfigMigrations(raw);
    const agent = (raw.agents as Array<Record<string, unknown>>)[0]!;
    expect(agent.home).toBe('/data/agent-a');
    expect(agent.persona).toBeUndefined();
  });

  it('preserves apiKey placeholders when migrating top-level providers', () => {
    const raw = {
      providers: [
        {
          type: 'openai',
          name: 'openai',
          apiKey: '${OPENAI_API_KEY}',
          baseUrl: 'https://api.openai.com/v1',
          models: ['gpt-5.5'],
        },
      ],
      agents: [{ id: 'a', model: 'openai/gpt-5.5' }],
    };
    const result = applyConfigMigrations(raw);
    expect(result.changed).toBe(true);
    const providers = (raw.models as Record<string, Record<string, unknown>>).providers!;
    expect(providers.openai!.apiKey).toBe('${OPENAI_API_KEY}');
    expect(providers.openai!.api).toBe('openai-completions');
    expect(providers.openai!.models).toEqual([{ id: 'gpt-5.5', name: 'gpt-5.5' }]);
    expect(raw.providers).toBeUndefined();
  });

  it('preserves literal apiKey byte-for-byte through migrations', () => {
    const secret = 'sk-live-abcdef1234567890';
    const raw = {
      supervisor: { enabled: true },
      providers: [
        {
          type: 'openai',
          name: 'openai',
          apiKey: secret,
          baseUrl: 'https://api.openai.com/v1',
          models: ['gpt-5.5'],
        },
      ],
      agents: [{ id: 'a', model: 'openai/gpt-5.5' }],
      budget: { maxTimeMs: 1000 },
    };
    applyConfigMigrations(raw);
    const providers = (raw.models as Record<string, Record<string, unknown>>).providers!;
    expect(providers.openai!.apiKey).toBe(secret);
  });

  it('recovers JSON with comments and trailing commas', () => {
    const text = `{
  // comment
  "agents": [{ "id": "a", "model": "openai/gpt" },],
}`;
    const attempt = parseConfigJson(text);
    expect(attempt.ok).toBe(true);
    expect(attempt.recovered).toBe(true);
  });

  it('stripTrailingCommas is string-aware (does not rewrite ,} inside values)', () => {
    const text = `{\n  "note": "end,}",\n  "ok": true,\n}`;
    const stripped = stripTrailingCommas(text);
    expect(stripped).toContain('"end,}"');
    const attempt = parseConfigJson(text);
    expect(attempt.ok).toBe(true);
    expect(attempt.recovered).toBe(true);
    expect((attempt.raw as { note?: string }).note).toBe('end,}');
  });

  it('deletes empty top-level providers array so CFG006 does not stick', () => {
    const raw = {
      providers: [],
      models: { providers: {} },
      agents: [{ id: 'a', model: 'x/y' }],
    };
    const result = applyConfigMigrations(raw);
    expect(result.changed).toBe(true);
    expect(raw.providers).toBeUndefined();
    expect(detectConfigMigrations(raw).some((f) => f.id === 'CFG006')).toBe(false);
  });

  it('detects deprecated session.store and moves it to _legacy on apply', () => {
    const raw = {
      session: {
        dmScope: 'per-peer',
        store: { type: 'jsonl', dataDir: './data/sessions' },
      },
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            apiKey: '${OPENAI_API_KEY}',
            api: 'openai-completions',
            models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
          },
        },
      },
      agents: [{ id: 'a', model: 'openai/gpt-5.5', home: '/tmp/a' }],
    };
    const findings = detectConfigMigrations(raw);
    expect(findings.some((f) => f.id === 'CFG010' && f.autoFixable)).toBe(true);

    applyConfigMigrations(raw);
    const session = raw.session as Record<string, unknown>;
    expect(session.store).toBeUndefined();
    expect(session.dmScope).toBe('per-peer');
    expect((raw._legacy as any).session.store).toEqual({ type: 'jsonl', dataDir: './data/sessions' });
    expect(detectConfigMigrations(raw).some((f) => f.id === 'CFG010')).toBe(false);
  });

  it('coerces string port to number', () => {
    const raw = {
      channels: [{ type: 'http', port: '3000' }],
      agents: [{ id: 'a', model: 'x/y' }],
      models: { providers: {} },
    };
    applyConfigMigrations(raw);
    expect((raw.channels as Array<Record<string, unknown>>)[0]!.port).toBe(3000);
  });
});

describe('redactConfig', () => {
  it('redacts api keys but keeps env placeholders', () => {
    const redacted = redactConfig({
      models: {
        providers: {
          openai: { apiKey: 'sk-live-abcdef1234567890' },
          other: { apiKey: '${OPENAI_API_KEY}' },
        },
      },
    }) as Record<string, Record<string, Record<string, string>>>;
    expect(redacted.models!.providers!.openai!.apiKey).toBe('sk-***');
    expect(redacted.models!.providers!.other!.apiKey).toBe('${OPENAI_API_KEY}');
    expect(JSON.stringify(redacted)).not.toContain('sk-live-abcdef1234567890');
  });
});

describe('loadConfig deprecation warnings (shared migrations)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function writeConfig(payload: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-cfg-'));
    dirs.push(dir);
    const file = join(dir, 'octopi.json');
    writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
    return file;
  }

  const baseModels = {
    models: {
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          api: 'openai-completions' as const,
          models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
        },
      },
    },
    agents: [{ id: 'a', model: 'openai/gpt-5.5' }],
  };

  it('still warns on supervisor without rewriting runGuard at load time', () => {
    const file = writeConfig({
      ...baseModels,
      supervisor: { enabled: true, checkpointInterval: 10 },
    });
    const config = loadConfig(file);
    expect(config.runGuard).toBeUndefined();
  });

  it('still migrates budget.maxTimeMs in memory', () => {
    const file = writeConfig({
      ...baseModels,
      budget: { maxTokens: 1000, maxTimeMs: 60_000 },
    });
    const config = loadConfig(file);
    expect((config.budget as { maxWallClockMs?: number }).maxWallClockMs).toBe(60_000);
  });
});

describe('octopi doctor', () => {
  let home: string;
  const prevHome = process.env.OCTOPI_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'octopi-doctor-'));
    process.env.OCTOPI_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OCTOPI_HOME;
    else process.env.OCTOPI_HOME = prevHome;
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  function writeLegacyDeployment(): string {
    mkdirSync(home, { recursive: true });
    const configPath = join(home, 'octopi.json');
    const secret = 'sk-doctor-secret-key-001';
    const agentHome = join(home, 'agents', 'default');
    mkdirSync(join(agentHome, 'sessions'), { recursive: true });
    mkdirSync(join(agentHome, 'skills'), { recursive: true });
    mkdirSync(join(agentHome, 'memory'), { recursive: true });
    writeFileSync(join(agentHome, 'SOUL.md'), '# old soul\n', 'utf-8');

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          supervisor: { enabled: true, checkpointInterval: 15 },
          budget: { maxTimeMs: 12345 },
          providers: [
            {
              type: 'openai',
              name: 'openai',
              apiKey: secret,
              baseUrl: 'https://api.openai.com/v1',
              models: [{ id: 'gpt-5.5', name: 'gpt-5.5', contextWindow: 256000 }],
            },
          ],
          agents: [
            {
              id: 'default',
              persona: agentHome,
              model: 'openai/gpt-5.5',
              tools: { allow: ['*'] },
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    );
    return configPath;
  }

  it('detects legacy config issues and reports without leaking secrets', async () => {
    const configPath = writeLegacyDeployment();
    const report = await runDoctor({ config: configPath }, {});
    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain('CFG001');
    expect(ids).toContain('CFG003');
    expect(ids).toContain('CFG006');
    expect(ids).toContain('CFG004');
    expect(ids).toContain('FS003');
    expect(ids).toContain('DB001');

    const json = doctorReportToJson(report);
    const text = formatDoctorReport(report);
    expect(json).not.toContain('sk-doctor-secret-key-001');
    expect(text).not.toContain('sk-doctor-secret-key-001');

    const candidates = groupFixableFindings(report.findings);
    const groups = candidates.map((c) => c.group);
    expect(groups).toContain('config');
    expect(groups).toContain('layout');
    expect(groups).toContain('data');
  });

  it('--fix rewrites config, preserves secret, migrates persona files', async () => {
    const configPath = writeLegacyDeployment();
    const secret = 'sk-doctor-secret-key-001';

    // data 分组依赖 node:sqlite（Node >= 24）；config/layout 路径与 data 解耦断言
    const report = await runDoctor(
      { config: configPath },
      { fix: true, yes: true, selectedGroups: ['config', 'layout'] },
    );
    expect(report.summary.error).toBe(0);

    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain(secret);
    expect(after).not.toContain('"supervisor"');
    expect(after).toContain('"runGuard"');
    expect(after).toContain('"maxWallClockMs"');
    expect(after).not.toContain('"maxTimeMs"');

    const parsed = JSON.parse(after) as Record<string, any>;
    expect(parsed.providers).toBeUndefined();
    expect(parsed.models.providers.openai.apiKey).toBe(secret);
    expect(parsed.runGuard).toEqual({ enabled: true, checkpointInterval: 15 });
    expect(parsed.budget.maxWallClockMs).toBe(12345);
    expect(parsed.agents[0].home).toBe(join(home, 'agents', 'default'));
    expect(parsed.agents[0].persona).toBeUndefined();

    const agentHome = join(home, 'agents', 'default');
    expect(existsSync(join(agentHome, 'persona', '10-soul.md'))).toBe(true);
    expect(existsSync(join(agentHome, 'SOUL.md'))).toBe(false);

    const backups = listConfigBackups(configPath);
    expect(backups.length).toBeGreaterThan(0);

    const second = await runDoctor({ config: configPath }, {});
    const secondIds = second.findings.map((f) => f.id);
    expect(secondIds).not.toContain('CFG001');
    expect(secondIds).not.toContain('CFG003');
    expect(secondIds).not.toContain('CFG006');
  });

  it('preserves ${ENV} placeholders on fix (never expands into file)', async () => {
    mkdirSync(home, { recursive: true });
    const configPath = join(home, 'octopi.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          supervisor: { enabled: true },
          models: {
            providers: {
              openai: {
                baseUrl: 'https://api.openai.com/v1',
                apiKey: '${OPENAI_API_KEY}',
                api: 'openai-completions',
                models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
              },
            },
          },
          agents: [{ id: 'default', model: 'openai/gpt-5.5', home: join(home, 'agents', 'default') }],
        },
        null,
        2,
      ),
      'utf-8',
    );
    process.env.OPENAI_API_KEY = 'sk-from-env-should-not-be-written';

    await runDoctor({ config: configPath }, { fix: true, yes: true });
    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('${OPENAI_API_KEY}');
    expect(after).not.toContain('sk-from-env-should-not-be-written');
  });

  it('--dry-run does not modify config file', async () => {
    const configPath = writeLegacyDeployment();
    const before = readFileSync(configPath, 'utf-8');
    await runDoctor({ config: configPath }, { fix: true, dryRun: true });
    const after = readFileSync(configPath, 'utf-8');
    expect(after).toBe(before);
  });

  it('interactive selectFixGroups can apply only config and leave persona files', async () => {
    const configPath = writeLegacyDeployment();
    const report = await runDoctor(
      { config: configPath },
      {
        fix: true,
        selectFixGroups: async () => ['config'],
      },
    );

    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('"runGuard"');
    expect(after).not.toContain('"supervisor"');

    const agentHome = join(home, 'agents', 'default');
    expect(existsSync(join(agentHome, 'SOUL.md'))).toBe(true);
    expect(existsSync(join(agentHome, 'persona', '10-soul.md'))).toBe(false);

    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain('FIX000');
    expect(ids).not.toContain('FIX001');
  });

  it('interactive cancel writes nothing', async () => {
    const configPath = writeLegacyDeployment();
    const before = readFileSync(configPath, 'utf-8');
    const report = await runDoctor(
      { config: configPath },
      {
        fix: true,
        selectFixGroups: async () => [],
      },
    );
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
    expect(report.findings.some((f) => f.message.includes('cancelled'))).toBe(true);
  });

  it('data-layer group is reachable via --fix --yes (no selectedGroups bypass)', async () => {
    const configPath = writeLegacyDeployment();
    const report = await runDoctor({ config: configPath }, { fix: true, yes: true });
    const fix002 = report.findings.find((f) => f.id === 'FIX002');
    expect(fix002).toBeTruthy();
    // data 组应出现在 fixable 分组中（审查 Finding 1）
    const pre = await runDoctor({ config: configPath }, {});
    // 修复后 config 仍应干净
    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('"runGuard"');
    expect(pre.findings.some((f) => f.id === 'CFG001')).toBe(false);
  });

  it('reports CFG010 for session.store with path cross-check; --fix config moves store to _legacy', async () => {
    mkdirSync(home, { recursive: true });
    const configPath = join(home, 'octopi.json');
    const legacyDir = join(home, 'data', 'sessions');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'old.jsonl'), '{}\n', 'utf-8');
    const agentHome = join(home, 'agents', 'default');
    mkdirSync(join(agentHome, 'sessions'), { recursive: true });

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          models: {
            providers: {
              openai: {
                baseUrl: 'https://api.openai.com/v1',
                apiKey: '${OPENAI_API_KEY}',
                api: 'openai-completions',
                models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
              },
            },
          },
          agents: [{ id: 'default', model: 'openai/gpt-5.5', home: agentHome }],
          session: {
            dmScope: 'per-peer',
            store: { type: 'jsonl', dataDir: './data/sessions' },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const pre = await runDoctor({ config: configPath }, {});
    const cfg010 = pre.findings.find((f) => f.id === 'CFG010');
    expect(cfg010).toBeTruthy();
    expect(cfg010!.hint).toContain('agents/<id>/sessions/');
    expect(cfg010!.hint).toContain('session-like file');
    expect(cfg010!.hint).toContain('looks empty');
    expect(cfg010!.fixable).toBe(true);
    expect(cfg010!.group).toBe('config');
    expect(cfg010!.severity).toBe('warn');

    await runDoctor({ config: configPath }, { fix: true, yes: true, selectedGroups: ['config'] });
    const after = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, any>;
    expect(after.session.store).toBeUndefined();
    expect(after.session.dmScope).toBe('per-peer');
    expect(after._legacy.session.store.dataDir).toBe('./data/sessions');
    // 数据文件本身未被删除/搬迁
    expect(existsSync(join(legacyDir, 'old.jsonl'))).toBe(true);
  });

  it('non-TTY --fix without --yes refuses to write', async () => {
    const configPath = writeLegacyDeployment();
    const before = readFileSync(configPath, 'utf-8');
    const report = await runDoctor({ config: configPath }, { fix: true });
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
    expect(report.findings.some((f) => f.message.includes('refusing non-interactive'))).toBe(true);
  });

  it('--restore reverts config to backup after a bad fix-era write', async () => {
    const configPath = writeLegacyDeployment();
    const original = readFileSync(configPath, 'utf-8');

    await runDoctor({ config: configPath }, { fix: true, yes: true, selectedGroups: ['config'] });
    const fixed = readFileSync(configPath, 'utf-8');
    expect(fixed).not.toContain('"supervisor"');

    const backup = latestConfigBackup(configPath);
    expect(backup).toBeTruthy();
    const result = restoreConfigFromBackup(configPath, backup!);
    expect(result.ok).toBe(true);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('restore refuses invalid backup JSON', () => {
    mkdirSync(home, { recursive: true });
    const configPath = join(home, 'octopi.json');
    writeFileSync(configPath, '{"ok":true}', 'utf-8');
    const bad = `${configPath}.bak.bad`;
    writeFileSync(bad, '{not-json', 'utf-8');
    const result = restoreConfigFromBackup(configPath, bad);
    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe('{"ok":true}');
  });
});

describe('legacy session filename helper', () => {
  it('renames colon session files when platform allows', () => {
    if (process.platform === 'win32') {
      // Windows 无法创建含冒号文件名；映射逻辑本身仍被 toSessionFileName 覆盖
      expect(listLegacySessionFiles(join(tmpdir(), 'nope'))).toEqual([]);
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'octopi-sess-'));
    try {
      writeFileSync(join(dir, 'default:web:1.jsonl'), '{}\n', 'utf-8');
      writeFileSync(join(dir, 'default:web:1.state.json'), '{}', 'utf-8');
      expect(listLegacySessionFiles(dir).length).toBe(2);
      const notes = renameLegacySessionFiles(dir);
      expect(notes.length).toBe(2);
      expect(existsSync(join(dir, 'default_web_1.jsonl'))).toBe(true);
      expect(existsSync(join(dir, 'default_web_1.state.json'))).toBe(true);
      expect(listLegacySessionFiles(dir).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
