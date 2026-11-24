/**
 * `octopi skill` — 技能审查与启停命令（人工审查面，arch/skill-creation-design.md §5/§6）
 *
 * 直接操作本地 OCTOPI_HOME/skill-state/skills.db（与 gateway/run 共享，sqlite WAL）。
 * 审查裁决经 SkillLifecycle 单一实现（批准即物化 staging → agents/<id>/skills/）。
 *
 * 用法：
 *   octopi skill list [agentId]                    查看注册表与审查队列
 *   octopi skill approve <agentId> <skillId>       批准 [--findings "…"]
 *   octopi skill reject <agentId> <skillId>        驳回 [--findings "…"]（findings 回传会话）
 *   octopi skill enable <agentId> <skillId>        启用（须已批准）
 *   octopi skill disable <agentId> <skillId>       停用（一键下线）
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getOctopiHome } from '../init.js';
import type { CliArgs } from './args.js';

/**
 * `octopi skill` 命令入口。
 *
 * @param args - CLI 参数（subcommand: list | approve | reject | enable | disable；
 *               positional: [skill, subcommand, agentId, skillId]）
 */
export async function skillCommand(args: CliArgs): Promise<void> {
  const home = getOctopiHome();
  const agentId = args.positional[2];
  const skillId = args.positional[3];

  const { SkillStateDatabase } = await import(
    '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/registry.js'
  );
  const { SkillLifecycle } = await import(
    '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/lifecycle.js'
  );
  const db = await SkillStateDatabase.create({
    dbPath: SkillStateDatabase.resolveDbPath(home),
  });

  try {
    switch (args.subcommand) {
      case 'list': {
        const ids = agentId ? [agentId] : listAgentIds(home);
        if (ids.length === 0) {
          console.log('ℹ️  No agents found under OCTOPI_HOME/agents.');
          return;
        }
        for (const id of ids) {
          const lifecycle = new SkillLifecycle({ db, octopiHome: home, agentId: id });
          const skills = lifecycle.list();
          const pending = lifecycle.listSubmissions('pending_review');
          console.log(`agent "${id}":`);
          if (skills.length === 0) {
            console.log('  (no skill registrations)');
          }
          for (const s of skills) {
            const state = s.reviewStatus === 'approved' ? (s.enabled ? 'enabled' : 'disabled') : s.reviewStatus;
            const marks = [state, s.source, s.unreviewed ? 'unreviewed' : 'reviewed'].join(', ');
            console.log(`  ${s.skillId}  [${marks}]  hash=${s.contentHash.slice(0, 18)}…`);
          }
          if (pending.length > 0) {
            console.log(`  pending review: ${pending.map((p) => `${p.skillId}(${p.submissionId.slice(0, 8)})`).join(', ')}`);
          }
        }
        return;
      }
      case 'approve':
      case 'reject': {
        const id = requireBoth(agentId, skillId);
        const lifecycle = new SkillLifecycle({ db, octopiHome: home, agentId: id.agentId });
        const result = await lifecycle.review({
          skillId: id.skillId,
          verdict: args.subcommand === 'approve' ? 'approved' : 'rejected',
          by: 'human:cli',
          findings: args.findings,
        });
        if (!result.ok) {
          // exitCode 而非 process.exit：让 finally 的 db.close() 执行（WAL 正常收尾）
          console.error(`❌ ${result.error}`);
          process.exitCode = 1;
          return;
        }
        if (args.subcommand === 'approve') {
          console.log(`✅ Approved "${id.skillId}" for agent "${id.agentId}" — installed to agents/${id.agentId}/skills/${id.skillId}/ and enabled.`);
        } else {
          console.log(`🚫 Rejected "${id.skillId}" for agent "${id.agentId}".${args.findings ? ` Findings: ${args.findings}` : ''}`);
          console.log('   The submitting agent sees the findings via skill_status and can revise and resubmit.');
        }
        return;
      }
      case 'enable':
      case 'disable': {
        const id = requireBoth(agentId, skillId);
        const lifecycle = new SkillLifecycle({ db, octopiHome: home, agentId: id.agentId });
        try {
          const record = lifecycle.setEnabled(id.skillId, args.subcommand === 'enable');
          console.log(
            `${args.subcommand === 'enable' ? '✅' : '⛔'} skill "${id.skillId}" for agent "${id.agentId}" is now ${record.enabled ? 'enabled' : 'disabled'}.`,
          );
        } catch (err) {
          // exitCode 而非 process.exit：让 finally 的 db.close() 执行（WAL 正常收尾）
          console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
        return;
      }
      case 'show': {
        // 审查内容面（设计 §5「预览 → 裁决」）：<skillId|submissionId> 均可定位
        const id = requireBoth(agentId, skillId);
        const lifecycle = new SkillLifecycle({ db, octopiHome: home, agentId: id.agentId });
        const record = lifecycle.list().find((r) => r.skillId === id.skillId);
        const submissionId = record?.submissionId ?? id.skillId;
        const preview = await lifecycle.previewSubmission(submissionId);
        if (!preview) {
          console.error(`❌ no submission found for "${id.skillId}" (agent "${id.agentId}")`);
          process.exitCode = 1;
          return;
        }
        console.log(`skill "${preview.skillId}" — submission ${preview.submissionId} [${preview.status}]`);
        console.log(`contentHash: ${preview.contentHash}`);
        if (preview.summary) console.log(`summary: ${preview.summary}`);
        console.log('files:');
        for (const f of preview.files) {
          console.log(`  ${f.path}${f.bytes < 0 ? ' (symlink!)' : ` (${f.bytes} B)`}`);
        }
        console.log('\n--- SKILL.md ---');
        console.log(preview.skillMd ?? '(missing)');
        return;
      }
      default:
        console.error(`Unknown skill subcommand: ${args.subcommand ?? '(missing)'}`);
        console.error(
          'Valid subcommands: list [agentId] | show <agentId> <skillId> | approve <agentId> <skillId> [--findings …] | reject <agentId> <skillId> [--findings …] | enable <agentId> <skillId> | disable <agentId> <skillId>',
        );
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

/** 位置参数双取；缺任一报错退出 */
function requireBoth(
  agentId: string | undefined,
  skillId: string | undefined,
): { agentId: string; skillId: string } {
  if (!agentId || !skillId) {
    console.error('Missing <agentId> and/or <skillId>. Usage: octopi skill <approve|reject|enable|disable> <agentId> <skillId>');
    process.exit(1);
  }
  return { agentId, skillId };
}

/** 枚举 OCTOPI_HOME/agents/ 下的 agent id（list 缺省全量巡检） */
function listAgentIds(home: string): string[] {
  try {
    return readdirSync(join(home, 'agents')).filter((name) => {
      try {
        return statSync(join(home, 'agents', name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
