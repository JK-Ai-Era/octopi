/**
 * kill switch（ops P5，`arch/ops-privileged-mode.md` §5 P5）——宿主侧急停
 *
 * 一条命令停掉 agent 的全部执行能力，**不依赖 LLM 判断与 agent 合作**：
 * 宿主写一个哨兵文件（`octopi ops kill <agentId>`），引擎在 run 准入与每次工具
 * 调用前检查——文件在 = 什么都不执行。删除文件（`octopi ops revive`）恢复。
 *
 * 设计约束：
 * - **宿主侧信号**：不走 LLM、不走 agent 工具面（agent 无法自己解除；它甚至无法
 *   阻止检查——检查点在 beforeToolCall，先于一切工具 handler）。
 * - **每次实查，不缓存**：急停必须即时生效，也必须可即时恢复。
 * - fail-closed：检查本身异常（stat 失败）按「未触发」处理不降级——哨兵缺失是
 *   常态；但**路径未配置**时不得假装有急停（诚实：没有检查点 = 没有 kill switch）。
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { getOctopiHome } from '../../../paths.js';

/** 急停状态 */
export interface KillSwitchState {
  engaged: boolean;
  /** 触发的哨兵文件路径（engaged=true 时给出） */
  path?: string;
}

/**
 * 默认哨兵路径（宿主布局）：`<OCTOPI_HOME>/agents/<agentId>/KILL`。
 *
 * @param agentId - agent 标识
 * @returns 哨兵文件绝对路径
 */
export function defaultKillSwitchPath(agentId: string): string {
  return join(getOctopiHome(), 'agents', agentId, 'KILL');
}

/**
 * 检查急停哨兵（每次实查；文件存在 = engaged）。
 *
 * @param paths - 哨兵路径列表（任一存在即触发）
 * @returns 急停状态
 */
export function checkKillSwitch(paths: readonly string[] | undefined): KillSwitchState {
  if (!paths || paths.length === 0) return { engaged: false };
  for (const path of paths) {
    try {
      if (statSync(path).isFile()) return { engaged: true, path };
    } catch {
      // 哨兵缺失是常态（未急停）；stat 失败同义，不制造假触发
    }
  }
  return { engaged: false };
}
