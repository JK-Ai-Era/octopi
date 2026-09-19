/**
 * 配置旧字段 / 手改损坏形态的检测与迁移
 *
 * 单一真相：loadConfig 告警 + doctor --fix 写回共用本模块。
 * 变换基于「未展开 env」的磁盘原义，禁止把 ${VAR} 写成明文。
 *
 * @module
 */

// ── 类型 ──

export type MigrationSeverity = 'error' | 'warn' | 'info';

export interface MigrationFinding {
  id: string;
  severity: MigrationSeverity;
  message: string;
  hint?: string;
  autoFixable: boolean;
}

export interface MigrationApplyResult {
  /** 是否改动了对象 */
  changed: boolean;
  notes: string[];
  findings: MigrationFinding[];
}

type RawObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRaw<T>(value: T): T {
  return structuredClone(value);
}

// ── 语法恢复（R001）──

/**
 * 去掉 JSON 字符串外的 // 与 /* *\/ 注释
 *
 * @param text - 原始配置文本
 * @returns 去掉注释后的文本
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 去掉对象/数组字面量前的尾逗号（字符串感知，避免改到值里的 `,}` / `,]`）
 *
 * @param text - JSON 文本
 * @returns 规范化后的文本
 */
export function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (j < text.length && (text[j] === '}' || text[j] === ']')) {
        // drop this comma; keep following whitespace/bracket as-is
        continue;
      }
    }
    out += ch;
  }
  return out;
}

export interface JsonParseAttempt {
  ok: boolean;
  raw?: unknown;
  recovered: boolean;
  error?: string;
}

/**
 * 解析配置 JSON；标准 parse 失败时尝试去注释与尾逗号
 *
 * @param text - 磁盘原文
 * @returns 解析结果
 */
export function parseConfigJson(text: string): JsonParseAttempt {
  try {
    return { ok: true, raw: JSON.parse(text), recovered: false };
  } catch (firstError) {
    const recoveredText = stripTrailingCommas(stripJsonComments(text));
    try {
      return { ok: true, raw: JSON.parse(recoveredText), recovered: true };
    } catch {
      return {
        ok: false,
        recovered: false,
        error: firstError instanceof Error ? firstError.message : String(firstError),
      };
    }
  }
}

// ── 标量类型纠正（R002，仅已知安全路径）──

/** 需要 number 的常见配置路径 */
const NUMBER_PATHS: Array<{ path: string[]; min?: number }> = [
  { path: ['channels', 'port'] },
  { path: ['budget', 'maxTokens'] },
  { path: ['budget', 'maxWallClockMs'] },
  { path: ['budget', 'softTokens'] },
  { path: ['budget', 'softWallClockMs'] },
  { path: ['budget', 'maxIterations'] },
  { path: ['budget', 'maxToolCalls'] },
  { path: ['runGuard', 'checkpointInterval'] },
  { path: ['runGuard', 'hardLimit'] },
  { path: ['runGuard', 'hardWallClockMs'] },
  { path: ['agentRuntime', 'coalesceWindowMs'] },
];

/** 需要 boolean 的常见配置路径 */
const BOOLEAN_PATHS: Array<{ path: string[] }> = [
  { path: ['runGuard', 'enabled'] },
  { path: ['agentRuntime', 'agentSignal'] },
  { path: ['memory', 'enabled'] },
];

function readPath(root: RawObject, path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function writePath(root: RawObject, path: string[], value: unknown): boolean {
  if (path.length === 0) return false;
  let cur: RawObject = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const next = cur[key];
    if (!isPlainObject(next)) return false;
    cur = next;
  }
  const last = path[path.length - 1]!;
  if (!(last in cur)) return false;
  cur[last] = value;
  return true;
}

/**
 * 将手改配置里可唯一确定的标量类型纠正为 schema 期望类型
 *
 * @param raw - 未展开的配置对象（就地修改）
 * @returns 是否发生变更
 */
export function coerceKnownScalarTypes(raw: RawObject): boolean {
  let changed = false;

  for (const { path } of NUMBER_PATHS) {
    // channels.port 是数组元素路径，单独处理
    if (path[0] === 'channels') continue;
    const value = readPath(raw, path);
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      if (writePath(raw, path, Number(value))) changed = true;
    }
  }

  for (const { path } of BOOLEAN_PATHS) {
    const value = readPath(raw, path);
    if (value === 'true' || value === 'false') {
      if (writePath(raw, path, value === 'true')) changed = true;
    }
  }

  if (Array.isArray(raw.channels)) {
    for (const ch of raw.channels) {
      if (!isPlainObject(ch)) continue;
      if (typeof ch.port === 'string' && ch.port.trim() !== '' && Number.isFinite(Number(ch.port))) {
        ch.port = Number(ch.port);
        changed = true;
      }
    }
  }

  return changed;
}

// ── 结构归一：顶层 providers → models.providers（R003）──

function providerKeyFromLegacy(item: RawObject): string {
  const name = typeof item.name === 'string' && item.name ? item.name : undefined;
  if (name) return name;
  const type = typeof item.type === 'string' && item.type ? item.type : undefined;
  if (type) return type;
  return 'default';
}

function apiFromLegacyType(type: string | undefined): 'openai-completions' | 'anthropic-messages' {
  if (type === 'anthropic') return 'anthropic-messages';
  return 'openai-completions';
}

function normalizeLegacyModels(models: unknown): Array<RawObject> {
  if (!Array.isArray(models)) return [];
  const out: RawObject[] = [];
  for (const m of models) {
    if (typeof m === 'string') {
      out.push({ id: m, name: m });
    } else if (isPlainObject(m)) {
      const id = typeof m.id === 'string' ? m.id : typeof m.model === 'string' ? m.model : undefined;
      if (!id) continue;
      out.push({ ...m, id, name: typeof m.name === 'string' ? m.name : id });
    }
  }
  return out;
}

/**
 * 将旧顶层 providers[] 归一到 models.providers（值随节点搬迁，含 apiKey 原样）
 *
 * @param raw - 未展开配置
 * @returns notes 与是否变更
 */
export function migrateTopLevelProviders(raw: RawObject): { changed: boolean; notes: string[] } {
  const notes: string[] = [];
  if (!Array.isArray(raw.providers)) return { changed: false, notes };

  if (!isPlainObject(raw.models)) {
    raw.models = {};
  }
  const models = raw.models as RawObject;
  if (!isPlainObject(models.providers)) {
    models.providers = {};
  }
  const target = models.providers as RawObject;

  let changed = false;
  const leftover: unknown[] = [];
  for (const item of raw.providers) {
    if (!isPlainObject(item)) {
      leftover.push(item);
      continue;
    }
    const key = providerKeyFromLegacy(item);
    const existing = target[key];
    // 已有新结构时不覆盖，避免丢用户后来写好的 providers
    if (isPlainObject(existing)) {
      notes.push(`models.providers.${key} already exists; legacy entry kept under _legacy.providers`);
      leftover.push(item);
      continue;
    }
    const legacyModels = normalizeLegacyModels(item.models);
    const next: RawObject = { ...item };
    delete next.name;
    if (typeof item.type === 'string') {
      next.api = apiFromLegacyType(item.type);
      delete next.type;
    }
    if (legacyModels.length > 0) next.models = legacyModels;
    // apiKey / baseUrl / 其它字段原样保留
    target[key] = next;
    notes.push(`providers[] → models.providers.${key}（apiKey 等字段原样搬迁）`);
    changed = true;
  }

  if (leftover.length > 0) {
    if (!isPlainObject(raw._legacy)) raw._legacy = {};
    (raw._legacy as RawObject).providers = leftover;
    changed = true;
  }

  if (Array.isArray(raw.providers) && (changed || Object.keys(target).length > 0 || raw.providers.length === 0)) {
    // 空数组或已搬迁/入 _legacy 后删除顶层 providers，避免 CFG006 粘住
    delete raw.providers;
    changed = true;
  }

  return { changed, notes };
}

// ── 已知字段迁移 ──

/**
 * 检测 supervisor / runGuard 冲突与旧字段
 *
 * @param raw - 配置对象
 * @returns finding 或 null
 */
export function detectSupervisor(raw: RawObject): MigrationFinding | null {
  if (!('supervisor' in raw)) return null;
  const hasNew = 'runGuard' in raw && isPlainObject(raw.runGuard);
  return {
    id: 'CFG001',
    severity: hasNew ? 'warn' : 'error',
    message: hasNew
      ? 'legacy field "supervisor" present alongside "runGuard"; supervisor will be ignored'
      : 'legacy field "supervisor" is ignored; rename to "runGuard"',
    hint: 'same fields; rename supervisor → runGuard to keep process supervision',
    autoFixable: true,
  };
}

/**
 * 就地迁移 supervisor → runGuard（新字段已存在时保留新字段）
 *
 * @param raw - 配置对象
 * @returns 是否变更
 */
export function applySupervisor(raw: RawObject): boolean {
  if (!('supervisor' in raw)) return false;
  const legacy = raw.supervisor;
  delete raw.supervisor;
  if (!('runGuard' in raw) || raw.runGuard === undefined) {
    if (isPlainObject(legacy)) {
      raw.runGuard = legacy;
      return true;
    }
  }
  return true;
}

/**
 * 检测 distributedIntelligence 旧顶层节点
 *
 * @param raw - 配置对象
 * @returns finding 或 null
 */
export function detectDistributedIntelligence(raw: RawObject): MigrationFinding | null {
  if (!('distributedIntelligence' in raw)) return null;
  return {
    id: 'CFG002',
    severity: 'warn',
    message: 'legacy field "distributedIntelligence" is ignored',
    hint: 'safety-guard params belong in subsystems/safety-guard/config.yaml; system subsystems only keeps framework fields (e.g. auditDir)',
    autoFixable: true,
  };
}

/**
 * 移除 distributedIntelligence（值无新落点可机械回填，迁入 _legacy 备份键）
 *
 * @param raw - 配置对象
 * @returns 是否变更
 */
export function applyDistributedIntelligence(raw: RawObject): boolean {
  if (!('distributedIntelligence' in raw)) return false;
  const legacy = raw.distributedIntelligence;
  delete raw.distributedIntelligence;
  if (!isPlainObject(raw._legacy)) raw._legacy = {};
  (raw._legacy as RawObject).distributedIntelligence = legacy;
  return true;
}

/**
 * 检测 budget.maxTimeMs
 *
 * @param raw - 配置对象
 * @returns finding 或 null
 */
export function detectBudgetMaxTimeMs(raw: RawObject): MigrationFinding | null {
  if (!isPlainObject(raw.budget) || !('maxTimeMs' in raw.budget)) return null;
  return {
    id: 'CFG003',
    severity: 'warn',
    message: 'budget.maxTimeMs is deprecated and ignored by schema',
    hint: 'rename to budget.maxWallClockMs',
    autoFixable: true,
  };
}

/**
 * 迁移 budget.maxTimeMs → maxWallClockMs
 *
 * @param raw - 配置对象
 * @returns 是否变更
 */
export function applyBudgetMaxTimeMs(raw: RawObject): boolean {
  if (!isPlainObject(raw.budget) || !('maxTimeMs' in raw.budget)) return false;
  const budget = raw.budget;
  const legacy = budget.maxTimeMs;
  delete budget.maxTimeMs;
  if (budget.maxWallClockMs === undefined && typeof legacy === 'number') {
    budget.maxWallClockMs = legacy;
  }
  return true;
}

/**
 * 检测 agents[].persona 字符串（旧 home）
 *
 * @param raw - 配置对象
 * @returns findings
 */
export function detectPersonaAsHome(raw: RawObject): MigrationFinding[] {
  const agents = raw.agents;
  if (!Array.isArray(agents)) return [];
  const findings: MigrationFinding[] = [];
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    if (!isPlainObject(agent)) continue;
    if (typeof agent.persona !== 'string') continue;
    const id = typeof agent.id === 'string' ? agent.id : String(i);
    if (typeof agent.home === 'string' && agent.home && agent.home !== agent.persona) {
      findings.push({
        id: 'CFG004',
        severity: 'warn',
        message: `agents[${id}]: persona path differs from home; string persona is deprecated`,
        hint: 'keep home; inline persona object if you need systemPrompt',
        autoFixable: false,
      });
    } else {
      findings.push({
        id: 'CFG004',
        severity: 'warn',
        message: `agents[${id}]: persona-as-string is deprecated (treated as home)`,
        hint: 'set agents[].home to the same path and drop persona string',
        autoFixable: true,
      });
    }
  }
  return findings;
}

/**
 * persona 字符串 → home（仅当 home 缺省或相同）
 *
 * @param raw - 配置对象
 * @returns 是否变更
 */
export function applyPersonaAsHome(raw: RawObject): boolean {
  const agents = raw.agents;
  if (!Array.isArray(agents)) return false;
  let changed = false;
  for (const agent of agents) {
    if (!isPlainObject(agent)) continue;
    if (typeof agent.persona !== 'string') continue;
    const path = agent.persona;
    if (typeof agent.home !== 'string' || !agent.home) {
      agent.home = path;
      delete agent.persona;
      changed = true;
    } else if (agent.home === path) {
      delete agent.persona;
      changed = true;
    }
  }
  return changed;
}

/**
 * 检测 $schema 是否指向明显无效位置
 *
 * @param raw - 配置对象
 * @returns finding 或 null
 */
export function detectSchemaRef(raw: RawObject): MigrationFinding | null {
  const schema = raw.$schema;
  if (typeof schema !== 'string' || !schema) return null;
  // 仅当仍写着远古相对路径且不是 octopi.schema.json 时提示
  if (schema.includes('octopi.schema.json')) return null;
  return {
    id: 'CFG005',
    severity: 'info',
    message: `$schema does not reference octopi.schema.json (${schema})`,
    hint: 'point $schema at ./octopi.schema.json or node_modules/octopi/octopi.schema.json',
    autoFixable: true,
  };
}

/**
 * 将 $schema 规范到包内 schema 相对提示路径
 *
 * @param raw - 配置对象
 * @returns 是否变更
 */
export function applySchemaRef(raw: RawObject): boolean {
  const schema = raw.$schema;
  if (typeof schema !== 'string' || !schema) return false;
  if (schema.includes('octopi.schema.json')) return false;
  raw.$schema = './node_modules/octopi/octopi.schema.json';
  return true;
}

/**
 * 检测废弃的 session.store（Gateway 忽略 store/dataDir，会话落在 agent.home/sessions）
 *
 * @param raw - 配置对象
 * @returns finding 或 null
 */
export function detectSessionStore(raw: RawObject): MigrationFinding | null {
  if (!isPlainObject(raw.session) || !('store' in raw.session)) return null;
  const session = raw.session as RawObject;
  const store = session.store;
  const dataDir = isPlainObject(store) && typeof store.dataDir === 'string' ? store.dataDir : undefined;
  return {
    id: 'CFG010',
    severity: 'warn',
    message: 'session.store is deprecated; Gateway ignores store/type/dataDir',
    hint: dataDir
      ? `runtime reads/writes agents/<id>/sessions/; configured dataDir "${dataDir}" is not used`
      : 'keep only session.dmScope; sessions live under agents/<id>/sessions/',
    autoFixable: true,
  };
}

/**
 * 将 session.store 移入 _legacy.session.store（保留 dmScope；不搬数据）
 *
 * @param raw - 配置对象
 * @returns 是否变更
 */
export function applySessionStore(raw: RawObject): boolean {
  if (!isPlainObject(raw.session) || !('store' in raw.session)) return false;
  const session = raw.session as RawObject;
  const store = session.store;
  delete session.store;
  if (store !== undefined) {
    if (!isPlainObject(raw._legacy)) raw._legacy = {};
    const legacy = raw._legacy as RawObject;
    if (!isPlainObject(legacy.session)) legacy.session = {};
    (legacy.session as RawObject).store = store;
  }
  return true;
}

/**
 * 检测顶层 providers 旧数组
 *
 * @param raw - 配置对象
 * @returns finding 或 null
 */
export function detectTopLevelProviders(raw: RawObject): MigrationFinding | null {
  if (!Array.isArray(raw.providers)) return null;
  return {
    id: 'CFG006',
    severity: 'error',
    message: 'top-level "providers" array is a legacy shape',
    hint: 'models.providers record; values are moved as-is (including apiKey)',
    autoFixable: true,
  };
}

/**
 * 检测手改后可安全纠正的标量类型
 *
 * @param raw - 配置对象
 * @returns finding 或 null
 */
export function detectScalarCoercion(raw: RawObject): MigrationFinding | null {
  const probe = cloneRaw(raw);
  const changed = coerceKnownScalarTypes(probe);
  if (!changed) return null;
  return {
    id: 'CFG007',
    severity: 'warn',
    message: 'some numeric/boolean config fields were written as strings',
    hint: 'coerce to JSON number/boolean at known paths',
    autoFixable: true,
  };
}

// ── 组合 API ──

/** 全量迁移规则（detect + apply） */
export interface ConfigMigrationRule {
  id: string;
  detect(raw: RawObject): MigrationFinding | null | MigrationFinding[];
  apply(raw: RawObject): boolean;
}

export const CONFIG_MIGRATION_RULES: ConfigMigrationRule[] = [
  { id: 'CFG001', detect: detectSupervisor, apply: applySupervisor },
  { id: 'CFG002', detect: detectDistributedIntelligence, apply: applyDistributedIntelligence },
  { id: 'CFG003', detect: detectBudgetMaxTimeMs, apply: applyBudgetMaxTimeMs },
  { id: 'CFG004', detect: detectPersonaAsHome, apply: applyPersonaAsHome },
  { id: 'CFG005', detect: detectSchemaRef, apply: applySchemaRef },
  { id: 'CFG006', detect: detectTopLevelProviders, apply: (raw) => migrateTopLevelProviders(raw).changed },
  { id: 'CFG007', detect: detectScalarCoercion, apply: (raw) => coerceKnownScalarTypes(raw) },
  { id: 'CFG010', detect: detectSessionStore, apply: applySessionStore },
];

/**
 * 检测配置中的旧字段与手改问题（不修改输入）
 *
 * @param raw - 未展开或已展开的配置对象
 * @returns findings 列表
 */
export function detectConfigMigrations(raw: unknown): MigrationFinding[] {
  if (!isPlainObject(raw)) return [];
  const findings: MigrationFinding[] = [];
  for (const rule of CONFIG_MIGRATION_RULES) {
    const result = rule.detect(raw);
    if (!result) continue;
    if (Array.isArray(result)) findings.push(...result);
    else findings.push(result);
  }
  return findings;
}

/**
 * 应用全部可自动迁移规则（就地修改 raw）
 *
 * @param raw - 配置对象
 * @returns 应用结果
 */
export function applyConfigMigrations(raw: unknown): MigrationApplyResult {
  if (!isPlainObject(raw)) {
    return { changed: false, notes: ['config root is not an object'], findings: [] };
  }
  const findings = detectConfigMigrations(raw);
  const notes: string[] = [];
  let changed = false;

  for (const rule of CONFIG_MIGRATION_RULES) {
    if (rule.id === 'CFG006') {
      const providersResult = migrateTopLevelProviders(raw);
      if (providersResult.changed) {
        changed = true;
        notes.push('applied CFG006', ...providersResult.notes);
      }
      continue;
    }
    const ruleChanged = rule.apply(raw);
    if (ruleChanged) {
      changed = true;
      notes.push(`applied ${rule.id}`);
    }
  }

  return { changed, notes, findings };
}

/**
 * 与 loadConfig 相同的 ${ENV} / ${ENV:-default} 展开（仅用于复检，不写回磁盘）
 *
 * @param text - 配置原文
 * @returns 展开后的文本
 */
export function expandEnvPlaceholders(text: string): string {
  return text.replace(/\$\{(\w+)(?::-(.*?))?\}/g, (_, key: string, defaultVal: string | undefined) => {
    const val = process.env[key];
    if (val !== undefined) return val;
    if (defaultVal !== undefined) return defaultVal;
    return '';
  });
}
