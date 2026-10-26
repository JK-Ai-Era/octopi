/**
 * `octopi ops` — 运维急停命令（ops P5 kill switch，`arch/ops-privileged-mode.md` §5 P5）
 *
 * 宿主侧信号，一条命令停掉 agent 的全部执行能力，**不依赖 LLM 判断与 agent 合作**：
 * 写哨兵文件 `<OCTOPI_HOME>/agents/<agentId>/KILL` → 引擎 run 准入 + 逐工具闸全拒；
 * 删除哨兵（`ops revive`）恢复。agent 自己无法解除（检查点在 beforeToolCall 之前，
 * 且哨兵由宿主文件系统权限保护）。
 *
 * 用法：
 *   octopi ops kill <agentId>      急停
 *   octopi ops revive <agentId>    恢复
 *   octopi ops status [agentId]    查看急停状态
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOctopiHome } from '../init.js';
import type { CliArgs } from './args.js';

/** 哨兵路径（与引擎 `defaultKillSwitchPath` 同布局） */
function killPathFor(agentId: string, homeDir = getOctopiHome()): string {
  return join(homeDir, 'agents', agentId, 'KILL');
}

/**
 * `octopi ops` 命令入口。
 *
 * @param args - CLI 参数（subcommand: kill | revive | status；target: agentId）
 */
export async function opsCommand(args: CliArgs): Promise<void> {
  const home = getOctopiHome();
  switch (args.subcommand) {
    case 'kill': {
      const agentId = requireAgentId(args.target);
      const path = killPathFor(agentId, home);
      mkdirSync(join(home, 'agents', agentId), { recursive: true });
      writeFileSync(
        path,
        `${JSON.stringify({ engagedAt: new Date().toISOString(), by: 'octopi ops kill' })}\n`,
      );
      console.log(`🛑 Kill switch engaged for agent "${agentId}".`);
      console.log(`   Sentinel: ${path}`);
      console.log('   All execution for this agent is refused (runs + every tool call).');
      console.log(`   Resume with: octopi ops revive ${agentId}`);
      return;
    }
    case 'revive': {
      const agentId = requireAgentId(args.target);
      const path = killPathFor(agentId, home);
      rmSync(path, { force: true });
      console.log(`✅ Kill switch released for agent "${agentId}".`);
      return;
    }
    case 'status': {
      if (args.target) {
        const path = killPathFor(args.target, home);
        const engaged = isFile(path);
        console.log(
          engaged
            ? `🛑 ${args.target}: KILLED (${path})`
            : `🟢 ${args.target}: running`,
        );
        return;
      }
      // 全量巡检：agents/ 下每个 agent 的急停态
      const agentsDir = join(home, 'agents');
      let ids: string[] = [];
      try {
        ids = readdirSync(agentsDir).filter((name) => {
          try {
            return statSync(join(agentsDir, name)).isDirectory();
          } catch {
            return false;
          }
        });
      } catch {
        ids = [];
      }
      if (ids.length === 0) {
        console.log('ℹ️  No agents found under OCTOPI_HOME/agents.');
        return;
      }
      for (const id of ids.sort()) {
        const engaged = isFile(killPathFor(id, home));
        console.log(`${engaged ? '🛑' : '🟢'} ${id}${engaged ? ' (killed)' : ''}`);
      }
      return;
    }
    default:
      console.error(`Unknown ops subcommand: ${args.subcommand ?? '(missing)'}`);
      console.error('Valid subcommands: kill <agentId> | revive <agentId> | status [agentId]');
      process.exit(1);
  }
}

function requireAgentId(target: string | undefined): string {
  if (!target) {
    console.error('Missing <agentId>. Usage: octopi ops <kill|revive> <agentId>');
    process.exit(1);
  }
  return target;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
