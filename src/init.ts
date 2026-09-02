/**
 * Octopi Init — 系统初始化模块
 *
 * 借鉴 OpenClaw 的做法：首次运行时自动脚手架目录结构。
 *
 * 目录结构：
 *   ~/.octopi/                         ← 系统根目录（OCTOPI_HOME）
 *     octopi.json                      ← 主配置文件
 *     workspace/
 *       default/                       ← 默认 agent 工作目录
 *         SOUL.md                      ← 人格定义
 *         IDENTITY.md                  ← 身份定义
 *         USER.md                      ← 用户上下文
 *         AGENTS.md                    ← 操作指令
 *         TOOLS.md                     ← 工具说明
 *     data/
 *       sessions/                      ← session 存储
 *     plugins/                         ← plugin 目录
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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// ── 常量 ──

/** 默认系统根目录 */
export const DEFAULT_OCTOPI_HOME = join(homedir(), '.octopi');

/** 环境变量名 */
export const OCTOPI_HOME_ENV = 'OCTOPI_HOME';

// ── Persona 模板 ──

const PERSONA_TEMPLATES: Record<string, string> = {
  'SOUL.md': `# SOUL.md - Agent Persona

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

  'IDENTITY.md': `# IDENTITY.md - Who Am I?

- **Name:** Assistant
- **Creature:** AI Assistant
- **Vibe:** Professional, helpful, reliable
- **Emoji:** 🐙

---

An AI assistant powered by Octopi framework.
`,

  'USER.md': `# USER.md - About Your Human

- **Name:** (your name)
- **What to call them:** (preferred name)
- **Timezone:** (your timezone)

---

_Fill in your info so the agent knows who it's talking to._
`,

  'AGENTS.md': `# AGENTS.md - Operating Instructions

## Session Startup

每次新 session：
1. 读 SOUL.md — 我是谁
2. 读 USER.md — 我在帮谁

## 核心规则

- 不确定时问用户，不要猜
- 完成任务后主动报告结果
- 保持回复简洁有用

---

_Customize this file to define your agent's operating procedures._
`,

  'TOOLS.md': `# TOOLS.md - Tool Reference

_记下常用工具和命令，方便快速查阅。_

---

## 常用操作

（在此添加你的常用命令和工具说明）

---

_This file is for quick reference. Keep it updated as you discover useful commands._
`,
};

// ── 默认配置模板 ──

function generateDefaultConfig(homeDir: string, agentId: string = 'default'): object {
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
    },
    agents: [
      {
        id: agentId,
        home: join(homeDir, 'agents', agentId),
        workspace: join(homeDir, 'workspace', agentId),
        model: 'openai/gpt-5.5',
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
      store: {
        type: 'jsonl',
        dataDir: join(homeDir, 'data/sessions'),
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
 * 2. 默认值 ~/octopi
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
 * 写入文件（仅在文件不存在时）
 *
 * @returns true 如果文件是新创建的，false 如果已存在
 */
function writeIfAbsent(filePath: string, content: string): boolean {
  if (existsSync(filePath)) {
    return false;
  }
  writeFileSync(filePath, content, 'utf-8');
  return true;
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
): Promise<{ created: string[]; existed: string[] }> {
  const created: string[] = [];
  const existed: string[] = [];

  // Home 目录（persona、memory、skills、sessions 的根目录）
  const homeDir2 = join(homeDir, 'agents', agentId);
  if (!existsSync(homeDir2)) {
    ensureDir(homeDir2);
    created.push(homeDir2);
  } else {
    existed.push(homeDir2);
  }

  // Workspace 目录（沙箱，agent 工具操作的 cwd）
  const workspaceDir = join(homeDir, 'workspace', agentId);
  if (!existsSync(workspaceDir)) {
    ensureDir(workspaceDir);
    created.push(workspaceDir);
  } else {
    existed.push(workspaceDir);
  }

  // Sessions 目录（在 home 下）
  const sessionsDir = join(homeDir2, 'sessions');
  if (!existsSync(sessionsDir)) {
    ensureDir(sessionsDir);
    created.push(sessionsDir);
  }

  // Persona 文件（直接放在 home 下）
  for (const [filename, content] of Object.entries(PERSONA_TEMPLATES)) {
    const filePath = join(homeDir2, filename);
    if (writeIfAbsent(filePath, content)) {
      created.push(filePath);
    } else {
      existed.push(filePath);
    }
  }

  return { created, existed };
}

/**
 * 完整初始化 Octopi 系统
 *
 * 创建完整的目录结构和默认配置文件。
 * 已存在的文件不会被覆盖。
 *
 * @param homeDir - 自定义系统根目录（默认 ~/octopi）
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
  ensureDir(home);
  if (isFresh) {
    created.push(home);
  } else {
    existed.push(home);
  }

  // 2. 子目录
  const subDirs = [
    'plugins',
  ];
  for (const dir of subDirs) {
    const fullPath = join(home, dir);
    if (!existsSync(fullPath)) {
      ensureDir(fullPath);
      created.push(fullPath);
    } else {
      existed.push(fullPath);
    }
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
