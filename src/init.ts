/**
 * Octopi Init — 系统初始化模块
 *
 * 首次运行时自动脚手架目录结构。
 *
 * 目录结构：
 *   ~/.octopi/                         ← 系统根目录（OCTOPI_HOME）
 *     octopi.json                      ← 主配置文件（系统级；不含资源访问密钥）
 *     audit/                           ← 子系统审计日志
 *     plugins/                         ← plugin 目录
 *     sessions/                        ← Session 一等存储（JsonlSessionStore）
 *     schedules.db                     ← SessionSchedule 作业表（timer_* / schedule_*）
 *     knowledge/                       ← Knowledge 服务数据面（knowledge.db 等）
 *     credentials/                     ← 集成凭证库（credentials.db；密文或 env 引用）
 *     plugin-state/<id>/               ← 插件私有状态目录（0700；api.stateDir）
 *     agents/
 *       default/                       ← agent home（persona / skills）
 *         AGENTS.md                    ← 主 persona（loadPersona 最先加载）
 *         persona/                     ← 补充 persona（字母序；数字前缀控制顺序）
 *           10-soul.md                 ← 人格定义
 *           20-identity.md             ← 身份定义
 *           30-user.md                 ← 用户上下文
 *         skills/                      ← 技能目录
 *
 * 说明：Memory / Cognition / Wisdom / Knowledge 不按文件目录落盘，
 * 统一由 AgentDatabase（per-agent SQLite agent.db）承载。
 * 旧 extract/（JsonlExtractorStore）目录已废弃，init 不再预建；
 * 记忆旁路见 memory.steward.*（docs/memory.md）。
 *
 *     workspace/
 *       <tenantId>/                    ← 租户段（arch/multi-tenancy.md §4 前缀隔离）
 *         <agentId>/                   ← agent 沙箱目录（工具操作 cwd）
 *
 * 使用方式：
 * ```ts
 * import { initOctopi, ensureAgentDirs } from 'octopi-agent';
 *
 * // 首次初始化（创建完整目录结构）
 * await initOctopi();
 *
 * // 确保单个 agent 的目录存在（新增 agent 时调用）
 * await ensureAgentDirs('my-agent', '/path/to/octopi-home');
 * ```
 */

import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAgentRole } from '@octopi-agent/engine/config-admin/agent-presets.js';
import type { ProductLang } from '@octopi-agent/engine/config-admin/i18n.js';
import {
  DEFAULT_OCTOPI_HOME,
  OCTOPI_HOME_ENV,
  getOctopiHome,
  agentHomeDir,
  agentWorkspaceDir,
} from '@octopi-agent/engine/paths.js';

export { DEFAULT_OCTOPI_HOME, OCTOPI_HOME_ENV, getOctopiHome };

// ── Persona 模板 ──
//
// loadPersona 约定（见 harness/agent/persona.ts）：
// - 根目录 AGENTS.md 最先加载
// - persona/*.md 按文件名字母序加载；数字前缀控制顺序
//
// 初始四件套（AGENTS.md + persona/{10-soul,20-identity,30-user}）不在本文件维护正文：
// 由 renderAgentRole('general', …) 生成——与向导创建的通用助手同源（单一真相源）；
// 且绝不指示 agent 用工具读 persona 文件（自动注入 system prompt，且 agent home
// 在 project/workspace 文件围栏外，读了必被拒）。

/**
 * 旧版布局下平铺在 agent home 根目录的 persona 文件，
 * 现应迁移到 persona/ 下（数字前缀保证加载顺序）。
 */
const LEGACY_PERSONA_MOVES: Array<{ from: string; to: string }> = [
  { from: 'SOUL.md', to: 'persona/10-soul.md' },
  { from: 'IDENTITY.md', to: 'persona/20-identity.md' },
  { from: 'USER.md', to: 'persona/30-user.md' },
  { from: 'TOOLS.md', to: 'persona/40-tools.md' },
];

// ── 默认配置模板 ──

export function generateDefaultConfig(
  homeDir: string,
  agentId: string = 'default',
  lang: ProductLang = 'zh',
): object {
  const agentHome = agentHomeDir(homeDir, agentId);
  return {
    $schema: './node_modules/octopi-agent/octopi.schema.json',
    // 产品语言（persona 四件套产物语言 / 向导与 WebUI 文案语言的缺省）
    language: lang,
    models: {
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: '${OPENAI_API_KEY}',
          api: 'openai-completions',
          models: [
            { id: 'gpt-6.2-astra', name: 'gpt-6.2-astra', contextWindow: 1050000, maxTokens: 128000 },
            { id: 'gpt-6.1-terra', name: 'gpt-6.1-terra', contextWindow: 1050000, maxTokens: 128000 },
            { id: 'gpt-6-luna', name: 'gpt-6-luna', contextWindow: 1050000, maxTokens: 128000 },
          ],
        },
      },
      // 脚手架档位：astra=最强、terra=均衡、luna=最轻（按官方模型页顺序取，非厂商声明的「档位」）
      level: {
        mini: { primary: 'openai/gpt-6-luna' },
        standard: { primary: 'openai/gpt-6.1-terra' },
        pro: { primary: 'openai/gpt-6.2-astra' },
      },
    },
    agents: [
      {
        id: agentId,
        home: agentHome,
        workspace: agentWorkspaceDir(homeDir, undefined, agentId),
        model: 'openai/gpt-6.2-astra',
        skillDirectory: join(agentHome, 'skills'),
        tools: { allow: ['*'] },
      },
    ],
    plugins: {
      loadPaths: [join(homeDir, 'plugins')],
    },
    // budgetPolicy：默认仅 wall-clock 安全阀（6h）；无 nominal token hard（arch/budget-redesign.md）
    // behavior → runGuard；context → capabilities summary/compact；成本策略 P3 budgetPolicy.units
    // 安全不可绕过：硬边界 + RiskPolicy 始终执行；此处只调处置/范围/灵敏度
    security: {
      enforce: 'block',
      injectionSensitivity: 'medium',
      allowedPaths: [],
    },
    // 编码 agent 档（project）：文件读写收在 workspace/事务根（strict 围栏），
    // shell 与网络放行；要全机无围栏请显式改 "host"，不可信输入用 workspace|untrusted；
    // 省略 mode 时 engine 缺省为 workspace（secure-by-default）。
    effectPolicy: {
      mode: 'project',
    },
    channels: [
      {
        type: 'http',
        port: 18180,
        // local=仅本机；lan=局域网访问
        host: 'local',
        path: '/messages',
        // B-1（2026-11-18 拍板）：init 默认生成随机 apiKey（secure-by-default）；
        // 局域网/远程访问凭此钥准入，审批归因 = 持钥方
        apiKey: randomBytes(32).toString('base64url'),
      },
    ],
    session: {
      dmScope: 'per-peer',
    },
    subsystems: {
      auditDir: join(homeDir, 'audit'),
    },
    web: {
      // local=仅本机；lan=局域网访问（需与 channels[].host 一致）
      host: 'local',
    },
    // 默认启用免费 DuckDuckGo；可改为 tavily/brave/serper 并配置 apiKey
    webSearch: {
      provider: 'duckduckgo',
      defaultLimit: 5,
      timeoutMs: 15000,
      providers: {
        duckduckgo: { api: 'duckduckgo' },
      },
    },
  };
}

// ── 核心函数 ──

/**
 * 确保目录存在（递归创建）
 */
function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

/**
 * 确保目录存在，并区分 created / existed
 */
function ensureDirTracked(
  path: string,
  created: string[],
  existed: string[],
): void {
  if (!existsSync(path)) {
    ensureDir(path);
    created.push(path);
  } else {
    existed.push(path);
  }
}

/**
 * 写入文件（仅在文件不存在时）
 *
 * @returns true 如果文件是新创建的，false 如果已存在
 */
function writeIfAbsent(filePath: string, content: string): boolean {
  if (existsSync(filePath)) {
    return false;
  }
  ensureDir(dirname(filePath));
  writeFileSync(filePath, content, 'utf-8');
  return true;
}

// ── 内置技能种子（随包发布的 skills/ → agents/<id>/skills/） ──

/**
 * 定位包内置 skills 目录（仓库/npm 包根的 `skills/`）。
 *
 * 从本模块位置向上查找含 `skills/document-authoring/SKILL.md` 的祖先目录
 * （dist/init.js 与源码 src/init.ts 均能解析到包根，不依赖固定相对深度）。
 *
 * @param fromDir - 起始目录（缺省本模块所在目录）
 * @returns 内置 skills 目录绝对路径；找不到返回 null（调用方降级 warn，不阻塞初始化）
 */
export function findBuiltinSkillsDir(fromDir?: string): string | null {
  let dir = fromDir ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'skills');
    if (existsSync(join(candidate, 'document-authoring', 'SKILL.md'))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 递归复制技能树（copy-if-missing，逐文件；用户数据/既有技能优先）
 */
function copyTreeIfAbsent(
  srcDir: string,
  destDir: string,
  seeded: string[],
  skipped: string[],
): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === '__pycache__') continue;
    const from = join(srcDir, entry.name);
    const to = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyTreeIfAbsent(from, to, seeded, skipped);
      continue;
    }
    if (!entry.isFile()) {
      // 符号链接/设备等非常规项：跳过并显式告知（复制它们会 EISDIR/ENOENT 炸掉初始化）
      console.warn(`[octopi] builtin skill seeding: skipped non-regular entry ${from}`);
      continue;
    }
    if (existsSync(to)) {
      skipped.push(to);
      continue;
    }
    ensureDir(dirname(to));
    copyFileSync(from, to);
    seeded.push(to);
  }
}

/**
 * 将内置技能种子进 agent 的 skills 目录。
 *
 * 语义与 persona 四件套一致：**已存在的文件不覆盖**（用户数据优先）。
 * 产品侧技能更新不自动覆盖用户改动——需要更新时显式重装（用户数据优先）。
 *
 * @param agentSkillsDir - 目标 skills 目录（`agents/<id>/skills`）
 * @param builtinDir - 内置 skills 源目录（缺省 findBuiltinSkillsDir()）
 * @returns seeded 新建文件 / skipped 已存在未动文件 / builtinDir 实际源（null = 未找到）
 */
export function seedBuiltinSkills(
  agentSkillsDir: string,
  builtinDir?: string,
): { seeded: string[]; skipped: string[]; builtinDir: string | null } {
  const src = builtinDir ?? findBuiltinSkillsDir();
  const seeded: string[] = [];
  const skipped: string[] = [];
  if (!src || !existsSync(src)) return { seeded, skipped, builtinDir: null };
  try {
    copyTreeIfAbsent(src, agentSkillsDir, seeded, skipped);
  } catch (e) {
    // 复制中途失败（I/O 等）：保留已拷部分（copy-if-missing 重试自愈），显式降级不阻塞初始化
    console.warn(`[octopi] builtin skill seeding incomplete: ${e}`);
  }
  return { seeded, skipped, builtinDir: src };
}

/**
 * 将旧版平铺在 home 根目录的 persona 文件迁移到 persona/ 下
 *
 * 仅当目标不存在时移动，避免覆盖用户已编辑的新文件。
 */
function migrateLegacyPersonaFiles(agentHome: string): string[] {
  const migrated: string[] = [];
  for (const { from, to } of LEGACY_PERSONA_MOVES) {
    const fromPath = join(agentHome, from);
    const toPath = join(agentHome, to);
    if (existsSync(fromPath) && !existsSync(toPath)) {
      ensureDir(dirname(toPath));
      renameSync(fromPath, toPath);
      migrated.push(toPath);
    }
  }
  return migrated;
}

/**
 * 初始化单个 Agent 的目录结构
 *
 * persona 初始四件套（AGENTS.md + 10-soul + 20-identity + 30-user）由
 * `renderAgentRole('general', …)` 按 `lang` 生成；已存在的文件不覆盖（用户数据优先）。
 *
 * @param agentId - Agent ID
 * @param homeDir - Octopi 系统根目录
 * @param tenantId - 归属租户（arch/multi-tenancy.md §4）；缺省 DEFAULT_TENANT_ID
 * @param lang - persona 产物语言（缺省 zh）
 * @returns 创建的目录列表
 */
export async function ensureAgentDirs(
  agentId: string,
  homeDir: string = getOctopiHome(),
  tenantId?: string,
  lang: ProductLang = 'zh',
): Promise<{ created: string[]; existed: string[]; migrated: string[] }> {
  const created: string[] = [];
  const existed: string[] = [];

  // Home 目录（persona / skills 的根目录）
  const agentHome = agentHomeDir(homeDir, agentId);
  ensureDirTracked(agentHome, created, existed);

  // Workspace 目录（沙箱，agent 工具操作的 cwd）：workspace/<tenantId>/<agentId>/ 前缀隔离。
  // 存量显式配置的 workspace 路径不搬家（§5 渐进）；本脚手架只出规范布局。
  ensureDirTracked(agentWorkspaceDir(homeDir, tenantId, agentId), created, existed);

  // Home 下的文件系统子目录。
  // memory/wisdom 不在此列：由 AgentDatabase（SQLite agent.db）承载。
  // sessions 一等存储在 OCTOPI_HOME/sessions/，不再预建 agents/<id>/sessions/。
  // 旧 extract/（ETL JsonlExtractorStore）不再预建。
  const homeSubDirs = [
    'skills',
  ];
  for (const dir of homeSubDirs) {
    ensureDirTracked(join(agentHome, dir), created, existed);
  }

  // 先迁移旧布局，再补模板——避免用模板覆盖用户已有的 SOUL.md 等
  const migrated = migrateLegacyPersonaFiles(agentHome);
  created.push(...migrated);

  // Persona 四件套：根目录 AGENTS.md + persona/{10-soul,20-identity,30-user}
  // （通用助手模板渲染产物；writeIfAbsent——已存在不覆盖）
  const rendered = renderAgentRole(
    'general',
    {
      agentName: lang === 'zh' ? '助手' : 'Assistant',
      addressToUser: lang === 'zh' ? '你' : 'you',
    },
    lang,
  );
  const initialFiles: Array<[string, string]> = [
    ['AGENTS.md', rendered.agentsMd],
    ...rendered.personaFiles.map(
      (f) => [`persona/${f.file}`, f.content] as [string, string],
    ),
  ];
  for (const [relativePath, content] of initialFiles) {
    const filePath = join(agentHome, relativePath);
    if (writeIfAbsent(filePath, content)) {
      created.push(filePath);
    } else {
      existed.push(filePath);
    }
  }

  // 内置技能种子：随包发布的 skills/ → agents/<id>/skills/（copy-if-missing，用户数据优先）
  const skillSeed = seedBuiltinSkills(join(agentHome, 'skills'));
  if (skillSeed.builtinDir === null) {
    // 种子缺失（打包遗漏/目录被移走）：显式降级，不阻塞初始化
    console.warn('[octopi] builtin skills directory not found next to package; skill seeding skipped');
  }
  created.push(...skillSeed.seeded);
  existed.push(...skillSeed.skipped);

  return { created, existed, migrated };
}

/**
 * 读取已有配置的产品语言（init 重入时保持 persona 产物语言一致）
 *
 * @param home - OCTOPI_HOME
 * @returns 'zh' | 'en'；配置不存在或不可读/值非法时返回 undefined（走缺省）
 */
function readConfigLanguage(home: string): ProductLang | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'octopi.json'), 'utf-8')) as {
      language?: unknown;
    };
    return raw.language === 'zh' || raw.language === 'en' ? raw.language : undefined;
  } catch {
    // 配置不存在/不可读/非 JSON：不阻塞初始化，按缺省语言走（随后会生成新配置）
    return undefined;
  }
}

/**
 * 完整初始化 Octopi 系统
 *
 * 创建完整的目录结构和默认配置文件。
 * 已存在的文件不会被覆盖。
 *
 * @param homeDir - 自定义系统根目录（默认 ~/.octopi）
 * @param options - 初始化选项
 * @returns 初始化报告
 */
export async function initOctopi(
  homeDir?: string,
  options: {
    /** 是否生成默认配置文件（默认 true） */
    generateConfig?: boolean;
    /** 默认 agent ID（默认 'default'） */
    defaultAgentId?: string;
    /** persona 产物语言（缺省：已有配置 language，再缺省 zh） */
    lang?: ProductLang;
  } = {},
): Promise<{
  homeDir: string;
  created: string[];
  existed: string[];
  configPath: string;
  isFresh: boolean;
}> {
  const home = homeDir ? resolve(homeDir) : getOctopiHome();
  const { generateConfig = true, defaultAgentId = 'default' } = options;
  // 产物语言：显式 options > 已有配置 language > zh（产品缺省）
  const lang = options.lang ?? readConfigLanguage(home) ?? 'zh';

  const created: string[] = [];
  const existed: string[] = [];
  // isFresh = 初始化前配置文件不存在（说明是全新安装）
  const isFresh = !existsSync(join(home, 'octopi.json'));

  // 1. 系统根目录
  ensureDirTracked(home, created, existed);

  // 2. 系统级子目录
  const subDirs = [
    'plugins',
    'audit',
    'sessions',
    'knowledge',
  ];
  for (const dir of subDirs) {
    ensureDirTracked(join(home, dir), created, existed);
  }

  // 3. 默认 Agent 目录
  const agentResult = await ensureAgentDirs(defaultAgentId, home, undefined, lang);
  created.push(...agentResult.created);
  existed.push(...agentResult.existed);

  // 4. 配置文件
  const configPath = join(home, 'octopi.json');
  if (generateConfig && !existsSync(configPath)) {
    const config = generateDefaultConfig(home, defaultAgentId, lang);
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    created.push(configPath);
  } else if (existsSync(configPath)) {
    existed.push(configPath);
  }

  return { homeDir: home, created, existed, configPath, isFresh };
}

/**
 * 检查系统是否已初始化
 */
export function isInitialized(homeDir?: string): boolean {
  const home = homeDir ? resolve(homeDir) : getOctopiHome();
  return existsSync(join(home, 'octopi.json'));
}

/**
 * 生成初始化报告（人类可读）
 */
/**
 * 初始化报告（CLI 展示）。
 *
 * @param result - initOctopi 结果
 * @param opts.context - 'init'（独立 init 命令，打 Next steps）| 'serve'（serve start 首启静默初始化——
 *   Next steps 里的「运行 serve start」正是用户正在执行的命令，改为指向随后打印的向导链接；评审 m2）
 * @returns 报告文本
 */
/**
 * 报告路径列表：skills/ 下的种子文件折叠为一行摘要（否则每次 init 打印近百行噪音）
 */
function pushCollapsedPaths(lines: string[], paths: string[], marker: string): void {
  const others: string[] = [];
  const skillRoots = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split(sep);
    const idx = parts.lastIndexOf('skills');
    if (idx > 0 && idx === parts.length - 2) {
      // skills/<file> 或更深：<skillsRoot> 记目录，计文件数
      const root = parts.slice(0, idx + 1).join(sep);
      skillRoots.set(root, (skillRoots.get(root) ?? 0) + 1);
    } else {
      others.push(p);
    }
  }
  for (const p of others) {
    lines.push(`     ${marker} ${p}`);
  }
  for (const [root, count] of skillRoots) {
    lines.push(`     ${marker} ${root} (${count} builtin skill files)`);
  }
}

export function formatInitReport(
  result: Awaited<ReturnType<typeof initOctopi>>,
  opts?: { context?: 'init' | 'serve' },
): string {
  const lines: string[] = [];

  lines.push(result.isFresh ? '🐙 Octopi initialized!' : '🐙 Octopi already initialized.');
  lines.push(`   Home: ${result.homeDir}`);
  lines.push(`   Config: ${result.configPath}`);

  if (result.created.length > 0) {
    lines.push(`\n   Created (${result.created.length}):`);
    pushCollapsedPaths(lines, result.created, '+');
  }

  if (result.existed.length > 0) {
    lines.push(`\n   Already existed (${result.existed.length}):`);
    pushCollapsedPaths(lines, result.existed, '=');
  }

  lines.push('\n   Next steps:');
  if (opts?.context === 'serve') {
    lines.push(`     1. 等下方 🧙 首启配置向导链接打印后，在浏览器打开走完九步向导`);
    lines.push(`     2. 或在终端走同款向导：octopi init`);
    lines.push(`     （进阶：手改 ${result.configPath} + 环境变量里的 API key）`);
  } else {
    lines.push(`     1. Run: octopi serve start — 打印首启配置向导链接（Web 九步向导，无需手改配置）`);
    lines.push(`     2. 或在终端走同款向导：octopi init`);
    lines.push(`     3. 配置完成后直接对话：octopi chat（终端）或浏览器打开 Web 控制台`);
    lines.push(`     （进阶：手改 ${result.configPath} + 环境变量里的 API key）`);
  }

  return lines.join('\n');
}
