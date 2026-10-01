/**
 * `web` — WebUI 配置段（→ 未来 @octopi-agent/webui）
 *
 * 用户仍写在单一 `octopi.json` 顶层 `web` 键。
 *
 * @module
 */
import { z } from 'zod';
import { NetworkHostSchema } from '@octopi-agent/engine/config-schema/shared.js';

export const WebConfigSchema = z.object({
  /** Web UI 目录（预构建 dist 或含 package.json 的 Vite 项目） */
  dir: z.string().optional(),
  /** 监听 host：local（默认仅本机）| lan（局域网）| 具体 IP/主机名 */
  host: NetworkHostSchema.optional(),
  /** 监听端口（默认 8180；`octopi webui start --port` 优先） */
  port: z.number().int().min(1).max(65535).optional(),
});
