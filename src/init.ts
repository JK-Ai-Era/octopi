/**
 * Octopi Init — 系统初始化模块
 *
 * 借鉴 OpenClaw 的做法：首次运行时自动脚手架目录结构。
 *
 * 目录结构：
 *   ~/.octopi/                         ← 系统根目录（OCTOPI_HOME）
 *     octopi.json                      ← 主配置文件
 *     audit/                           ← 子系统审计日志
 *     plugins/                         ← plugin 目录
 *     agents/
 *       default/                       ← agent home（persona / skills / sessions）
 *         AGENTS.md                    ← 主 persona（loadPersona 最先加载）
 *         persona/                     ← 补充 persona（字母序；数字前缀控制顺序）
 *           10-soul.md                 ← 人格定义
 *           20-identity.md             ← 身份定义
 *           30-user.md                 ← 用户上下文
 *           40-tools.md                ← 工具说明
 *         sessions/                    ← session 存储（JsonlSessionStore）
 *         skills/                      ← 技能目录
 *
 * 说明：Memory / Cognition / Wisdom / Knowledge 不按文件目录落盘，
 * 统一由 AgentDatabase（per-agent SQLite agent.db）承载。
 * 旧 extract/（JsonlExtractorStore）目录已废弃，init 不再预建；
 * 记忆旁路见 memory.steward.*（docs/memory-system-redesign.md）。
 *
 *     workspace/
 *       default/                       ← agent 沙箱目录（工具操作 cwd）
 *
 * 使用方式：
 * ```ts
 * import { initOctopi, ensureAgentDirs } from 'octopi/init';
 *
 * // 首次初始化（创建完整目录结构）
 * await initOctopi();
 *
 * // 确保单个 agent 的目录存在（新增 agent 时调用）
 * await ensureAgentDirs('my-agent', '/path/to/octopi-home');
 * ```
 */

import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// ── 常量 ──

/** 默认系统根目录 */
export const DEFAULT_OCTOPI_HOME = join(homedir(), '.octopi');

/** 环境变量名 */
export const OCTOPI_HOME_ENV = 'OCTOPI_HOME';

// ── Persona 模板 ──
//
// loadPersona 约定（见 harness/agent-building/persona.ts）：
// - 根目录 AGENTS.md 最先加载
// - persona/*.md 按文件名字母序加载；数字前缀控制顺序
const PERSONA_TEMPLATES: Record<string, string> = {
  'persona/10-soul.md': `# Soul - Agent Persona

_这是你的 Agent 人格定义。修改此文件来定制 Agent 的行为风格。_

---

## 声音

**专业、友好。** 用清晰简洁的语言回答问题。

**主动思考。** 不只是执行命令，要理解用户意图，提供有价值的建议。

**对结果负责。** 完成任务后主动验证，确保结果正确。

## 核心原则

- 理解用户真实需求，而非字面意思
- 遇到不确定时，主动确认而非猜测
- 保持一致性，建立可预测的行为模式

---

_Customize this file to shape your agent's personality._
`,

  'persona/20-identity.md': `# Identity - Who Am I?

- **Name:** Assistant
- **Creature:** AI Assistant
- **Vibe:** Professional, helpful, reliable
- **Emoji:** 🐙

---

An AI assistant powered by Octopi framework.
`,

  'persona/30-user.md': `# User - About Your Human

- **Name:** (your name)
- **What to call them:** (preferred name)
- **Timezone:** (your timezone)

---

_Fill in your info so the agent knows who it's talking to._
`,

  'persona/40-tools.md': `# Tools - Tool Reference

_记下常用工具和命令，方便快速查阅。_

---

## 常用操作

（在此添加你的常用命令和工具说明）

---

_This file is for quick reference. Keep it updated as you discover useful commands._
`,

  'AGENTS.md': `# AGENTS.md - Operating Instructions

## Session Startup

每次新 session：
1. 读 persona/10-soul.md — 我是谁
2. 读 persona/30-user.md — 我在帮谁

## 核心规则

- 不确定时问用户，不要猜
- 完成任务后主动报告结果
- 保持回复简洁有用

---

_Customize this file to define your agent's operating procedures._
`,
};

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

function generateDefaultConfig(homeDir: string, agentId: string = 'default'): object {
  const agentHome = join(homeDir, 'agents', agentId);
  return {
    $schema: './node_modules/octopi/octopi.schema.json',
    models: {
      mode: 'merge',
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: '${OPENAI_API_KEY}',
          api: 'openai-completions',
          models: [
            { id: 'gpt-5.5', name: 'gpt-5.5', contextWindow: 256000, maxTokens: 32768 },
            { id: 'gpt-5-mini', name: 'gpt-5-mini', contextWindow: 128000, maxTokens: 16384 },
          ],
        },
      },
      level: {
        mini: { primary: 'openai/gpt-5-mini' },
        standard: { primary: 'openai/gpt-5.5' },
        pro: { primary: 'openai/gpt-5.5' },
      },
    },
    agents: [
      {
        id: agentId,
        home: agentHome,
        workspace: join(homeDir, 'workspace', agentId),
        model: 'openai/gpt-5.5',
        skillDirectory: join(agentHome, 'skills'),
        tools: { allow: ['*'] },
      },
    ],
    plugins: {
      loadPaths: [join(homeDir, 'plugins')],
    },
    // budget 使用默认值（1000 迭代/5000 工具调用/1M tokens/10h），无需显式配置
    security: {
      preset: 'production',
    },
    channels: [
      {
        type: 'http',
        port: 3000,
        path: '/messages',
      },
    ],
    session: {
      dmScope: 'per-peer',
    },
    subsystems: {
      auditDir: join(homeDir, 'audit'),
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
 * 获取 Octopi 系统根目录
 *
 * 优先级：
 * 1. 环境变量 OCTOPI_HOME
 * 2. 默认值 ~/.octopi
 */
export function getOctopiHome(): string {
  return resolve(process.env[OCTOPI_HOME_ENV] ?? DEFAULT_OCTOPI_HOME);
}

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
 * @param agentId - Agent ID
 * @param homeDir - Octopi 系统根目录
 * @returns 创建的目录列表
 */
export async function ensureAgentDirs(
  agentId: string,
  homeDir: string = getOctopiHome(),
): Promise<{ created: string[]; existed: string[]; migrated: string[] }> {
  const created: string[] = [];
  const existed: string[] = [];

  // Home 目录（persona / skills / sessions 的根目录）
  const agentHome = join(homeDir, 'agents', agentId);
  ensureDirTracked(agentHome, created, existed);

  // Workspace 目录（沙箱，agent 工具操作的 cwd）
  ensureDirTracked(join(homeDir, 'workspace', agentId), created, existed);

  // Home 下的文件系统子目录。
  // memory/wisdom 不在此列：由 AgentDatabase（SQLite agent.db）承载。
  // 旧 extract/（ETL JsonlExtractorStore）不再预建。
  const homeSubDirs = [
    'sessions',
    'skills',
  ];
  for (const dir of homeSubDirs) {
    ensureDirTracked(join(agentHome, dir), created, existed);
  }

  // 先迁移旧布局，再补模板——避免用模板覆盖用户已有的 SOUL.md 等
  const migrated = migrateLegacyPersonaFiles(agentHome);
  created.push(...migrated);

  // Persona 文件：根目录 AGENTS.md + persona/ 下的补充人格
  for (const [relativePath, content] of Object.entries(PERSONA_TEMPLATES)) {
    const filePath = join(agentHome, relativePath);
    if (writeIfAbsent(filePath, content)) {
      created.push(filePath);
    } else {
      existed.push(filePath);
    }
  }

  return { created, existed, migrated };
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
  ];
  for (const dir of subDirs) {
    ensureDirTracked(join(home, dir), created, existed);
  }

  // 3. 默认 Agent 目录
  const agentResult = await ensureAgentDirs(defaultAgentId, home);
  created.push(...agentResult.created);
  existed.push(...agentResult.existed);

  // 4. 配置文件
  const configPath = join(home, 'octopi.json');
  if (generateConfig && !existsSync(configPath)) {
    const config = generateDefaultConfig(home, defaultAgentId);
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
export function formatInitReport(result: Awaited<ReturnType<typeof initOctopi>>): string {
  const lines: string[] = [];

  lines.push(result.isFresh ? '🐙 Octopi initialized!' : '🐙 Octopi already initialized.');
  lines.push(`   Home: ${result.homeDir}`);
  lines.push(`   Config: ${result.configPath}`);

  if (result.created.length > 0) {
    lines.push(`\n   Created (${result.created.length}):`);
    for (const path of result.created) {
      lines.push(`     + ${path}`);
    }
  }

  if (result.existed.length > 0) {
    lines.push(`\n   Already existed (${result.existed.length}):`);
    for (const path of result.existed) {
      lines.push(`     = ${path}`);
    }
  }

  lines.push('\n   Next steps:');
  lines.push(`     1. Edit ${result.configPath} to configure your providers`);
  lines.push(`     2. Set OPENAI_API_KEY (or other provider keys) in your environment`);
  lines.push(`     3. Run: octopi serve`);
  lines.push(`     4. Or chat directly: octopi chat`);

  return lines.join('\n');
}
