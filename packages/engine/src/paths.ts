/**
 * Runtime home path helpers (OCTOPI_HOME).
 * Shared by gateway / suite so neither depends on the other for path resolution.
 *
 * This module must stay zod-free: harness runtime code imports it for path
 * semantics without pulling in the config-schema layer.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_TENANT_ID } from '@octopi-agent/core/types.js';

/**
 * 展开 `~` 前缀为用户主目录（Windows/Linux/macOS 通用）。
 * 接受 `~`、`~/rest`、`~\rest`（Windows 形态，剩余分隔符归一为 `/` 后按平台 join）；
 * `~user/…` 等其他形态不展开（无跨平台语义）。已是绝对路径的原样返回（幂等）。
 *
 * @param p - 配置原文路径
 * @returns 展开后的路径
 */
export function expandHomePath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    // `~\a\b` 多段：把剩余的 `\` 归一为 `/`，避免 POSIX 上把 `\` 当文件名字符
    return join(homedir(), p.slice(2).replace(/\\/g, '/'));
  }
  return p;
}

/**
 * 配置路径合法形态：绝对路径，或 `~` / `~/…` / `~\…`。
 * win32 上「绝对」要求盘符（`C:\`/`C:/`）或 UNC（`\\server\share`）——
 * `\foo` 这类盘符相对路径会按当前盘隐式解析，属于要消灭的隐式行为。
 * 相对路径直接拒绝：被 resolve 到进程 cwd 属于隐式行为，加载即报错。
 *
 * @param p - 配置原文路径
 * @returns 形态合法与否
 */
export function isConfigPathShape(p: string): boolean {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return true;
  if (process.platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  }
  return isAbsolute(p);
}


/** 默认系统根目录 */
export const DEFAULT_OCTOPI_HOME = join(homedir(), '.octopi');

/** 环境变量名 */
export const OCTOPI_HOME_ENV = 'OCTOPI_HOME';

/**
 * 获取 Octopi 系统根目录
 *
 * 优先级：
 * 1. 环境变量 OCTOPI_HOME
 * 2. 默认值 ~/.octopi
 *
 * @returns 绝对路径
 */
export function getOctopiHome(): string {
  return resolve(process.env[OCTOPI_HOME_ENV] ?? DEFAULT_OCTOPI_HOME);
}

// ── 家当路径派生（arch/multi-tenancy.md §4 隔离矩阵的单一来源） ──

/** 路径段守卫：目录名不得为空 / 含分隔符 / 含 `..`（containment 安全判定点） */
function assertPathSegment(segment: string, label: string): string {
  if (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw new Error(`invalid ${label} path segment: ${JSON.stringify(segment)}`);
  }
  return segment;
}

/**
 * agent home 物化路径（§4：`agents/<agentId>/`，registry 标注 tenantId）。
 *
 * @param octopiHome - OCTOPI_HOME 绝对路径
 * @param agentId - agent id（registry 管理的为 UUID；配置 agent 为配置 id）
 * @returns agent home 目录
 */
export function agentHomeDir(octopiHome: string, agentId: string): string {
  return join(octopiHome, 'agents', assertPathSegment(agentId, 'agent id'));
}

/**
 * agent workspace 物化路径（§4：`workspace/<tenantId>/<agentId>/` 路径前缀隔离）。
 * 显式配置的 `agents[].workspace` 优先于本派生（§5 渐进迁移：存量配置不搬家）。
 *
 * @param octopiHome - OCTOPI_HOME 绝对路径
 * @param tenantId - 归属租户；缺省 `DEFAULT_TENANT_ID`（存量/未接身份层）
 * @param agentId - agent id
 * @returns agent workspace 目录
 */
export function agentWorkspaceDir(
  octopiHome: string,
  tenantId: string | undefined,
  agentId: string,
): string {
  return join(
    octopiHome,
    'workspace',
    assertPathSegment(tenantId ?? DEFAULT_TENANT_ID, 'tenant id'),
    assertPathSegment(agentId, 'agent id'),
  );
}
