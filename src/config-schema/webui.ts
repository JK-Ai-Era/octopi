/**
 * `web` — WebUI 配置段（→ 未来 @octopi-agent/webui）
 *
 * 用户仍写在单一 `octopi.json` 顶层 `web` 键。
 *
 * @module
 */
import { z } from 'zod';
import { NetworkHostSchema } from '@octopi-agent/engine/config-schema/shared.js';

/**
 * `web.gitStatusPollSeconds` 契约边界（秒）。
 * 浏览器包引不到 suite：`packages/webui/src/runtime-config.ts` 有一份镜像校验，
 * 改边界时同步改那里。
 */
export const GIT_STATUS_POLL_SECONDS_MAX = 3600;

/** 缺省轮询间隔（秒）：未配置/非法时的内置回退 */
export const DEFAULT_GIT_STATUS_POLL_SECONDS = 5;

/**
 * 校验 gitStatusPollSeconds（0..3600 整数）。
 *
 * @param value - 配置原文
 * @returns 0 = 不自动轮询；其余为周期秒数
 */
export function isValidGitStatusPollSeconds(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= GIT_STATUS_POLL_SECONDS_MAX
  );
}

export const WebConfigSchema = z.object({
  /** Web UI 目录（预构建 dist 或含 package.json 的 Vite 项目） */
  dir: z.string().optional(),
  /** 监听 host：local（默认仅本机）| lan（局域网）| 具体 IP/主机名 */
  host: NetworkHostSchema.optional(),
  /** 监听端口（默认 8180；`octopi webui start --port` 优先） */
  port: z.number().int().min(1).max(65535).optional(),
  /**
   * WebUI Git 页签轮询间隔（秒）；0 = 不自动轮询（选中/切换目录与手动刷新仍即时拉取）。
   * 每次轮询 spawn git 子进程，低值（1–2s）在大仓上开销可观。改后需 `octopi webui restart`。
   */
  gitStatusPollSeconds: z.number().int().min(0).max(GIT_STATUS_POLL_SECONDS_MAX).optional(),
});
