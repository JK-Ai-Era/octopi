/**
 * 工具效应面隔离策略（宪法 I5，最小集）
 *
 * `agent.workspace` 只表示工具磁盘 cwd，不是 Run 上下文。
 * 本模块解析「本 Run 的 toolRuntime.cwd」，不引入分布式文件锁。
 */

import { isAbsolute, join, resolve, sep } from 'node:path';
import { toSessionFileName } from '../../integration/storage/session-filename.js';

/** 工具效应隔离模式（部署可配；schema 字段 `toolIsolation`） */
export type ToolIsolationMode = 'none' | 'session-subdir' | 'session-lock';

/**
 * 缺省隔离模式。
 *
 * `'none'`：保持既有行为——多 Session 共享 agent.workspace / RunConfig.cwd。
 * 多 Session 并发写文件时，宿主应显式配置 `session-subdir`。
 */
export const DEFAULT_TOOL_ISOLATION: ToolIsolationMode = 'none';

/** resolveToolIsolationCwd 入参 */
export interface ResolveToolIsolationCwdInput {
  /** 生效隔离模式 */
  mode: ToolIsolationMode;
  /** 本 Run 的 sessionId */
  sessionId: string;
  /**
   * 基路径：RunConfig.cwd 优先，否则 agent.workspace。
   * 空白视为未配置。
   */
  baseCwd?: string;
}

/** resolveToolIsolationCwd 结果 */
export interface ResolveToolIsolationCwdResult {
  /** 写入 runScope.toolRuntime.cwd 的路径；undefined = 交由 Provider/工具回退 */
  cwd?: string;
  /** 实际生效的隔离模式 */
  mode: ToolIsolationMode;
}

/**
 * 将 sessionId 映射为可安全 join 的目录名
 *
 * @param sessionId - 逻辑会话 id
 * @returns 文件系统安全段（禁止 `..` / 分隔符 / 绝对路径）
 */
export function safeSessionDirSegment(sessionId: string): string {
  return toSessionFileName(sessionId);
}

/**
 * 解析本 Run 工具 cwd（I5）
 *
 * - `none`：cwd = baseCwd（与历史行为一致；未配置则 undefined）
 * - `session-subdir`：cwd = join(baseCwd, safe(sessionId))；无 baseCwd 时不发明路径；
 *   解析结果必须仍位于 baseCwd 之下，否则退回 baseCwd（防路径穿越）
 * - `session-lock`：cwd = baseCwd（共享路径）；并发安全依赖 Runner 的
 *   **sessionId 锁**（E1/E2），**不**提供跨 Session 路径隔离
 *
 * @param input - 模式 + 会话身份 + 基路径
 * @returns 工具 cwd 与生效模式
 */
export function resolveToolIsolationCwd(input: ResolveToolIsolationCwdInput): ResolveToolIsolationCwdResult {
  const base = input.baseCwd?.trim() ? input.baseCwd.trim() : undefined;
  const mode = input.mode;

  if (mode === 'session-subdir' && base) {
    const segment = safeSessionDirSegment(input.sessionId);
    const resolvedBase = resolve(base);
    const candidate = resolve(join(resolvedBase, segment));
    const prefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
    // 绝对/越界 sessionId（含 Windows 盘符）消毒后仍须落在 base 内
    if (candidate === resolvedBase || candidate.startsWith(prefix)) {
      return { cwd: candidate, mode };
    }
    return { cwd: resolvedBase, mode };
  }
  return { cwd: base, mode };
}

/** @internal 测试辅助：是否为绝对路径段（未使用消毒名时） */
export function looksLikeAbsoluteSessionPath(sessionId: string): boolean {
  return isAbsolute(sessionId) || sessionId.includes('..') || /[/\\]/.test(sessionId);
}
