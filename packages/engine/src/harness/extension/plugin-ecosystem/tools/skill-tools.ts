/**
 * skill_submit / skill_status 工具 — 技能自创建的提交与状态面
 * （arch/skill-creation-design.md §4）
 *
 * 安全边界（设计 §2 判断 2）：
 * - skill_submit 只读 workspace 内的起草目录（L2 containment 同 file_* 工具），
 *   写入只发生在引擎区 staging（经 SkillLifecycle，agent 不可写目标）；
 * - 校验失败返回逐项错误清单（该清单是规范权威，agent 据此修复重提）；
 * - 工具不物化技能——批准物化只在 SkillLifecycle.review（人工/审查面）发生。
 */

import type { RegisteredTool } from '@octopi-agent/core/types.js';
import { statSync } from 'node:fs';
import {
  containmentOptions,
  resolveToolPath,
} from './platform.js';
import type { SkillLifecycle } from '../skills/lifecycle.js';

/** 工具 handler 的 containment 上下文（与 file-ops 同形） */
interface SkillToolContext {
  cwd?: string;
  pathRoots?: string[];
  pathContainment?: 'strict' | 'soft' | 'none';
}

export interface SkillToolOptions {
  lifecycle: SkillLifecycle;
}

/**
 * 创建 skill_submit / skill_status 工具
 *
 * @param options - SkillLifecycle（提交/查询的单一实现）
 * @returns 两个工具的注册数组
 */
export function createSkillTools(options: SkillToolOptions): RegisteredTool[] {
  return [
    createSkillSubmitTool(options.lifecycle),
    createSkillStatusTool(options.lifecycle),
  ];
}

function createSkillSubmitTool(lifecycle: SkillLifecycle): RegisteredTool {
  return {
    definition: {
      name: 'skill_submit',
      capabilities: ['fs-read', 'fs-write'],
      description:
        'Submit a skill draft for review. Provide the path to a skill directory you authored ' +
        '(must contain SKILL.md with valid Agent Skills frontmatter: name matching the directory, description). ' +
        'The draft is copied to an engine staging area and enters the review queue (human or LLM per policy). ' +
        'On validation failure, returns an itemized issue list — fix and resubmit. ' +
        'The skill becomes available only after approval; check progress with skill_status.',
      parameters: {
        path: {
          type: 'string',
          description:
            'Path to the skill draft directory (SKILL.md at its root; usually under scratch/ in the workspace).',
        },
        summary: {
          type: 'string',
          description: 'Optional one-line summary of what the skill does and why it was created (shown to reviewers).',
        },
      },
    },
    handler: async (args, context) => {
      const rawPath = (args as { path?: unknown }).path;
      if (typeof rawPath !== 'string' || !rawPath.trim()) {
        throw new Error('skill_submit: "path" (string) is required');
      }
      const ctx = context as SkillToolContext | undefined;
      const sourceDir = resolveToolPath(rawPath, ctx?.cwd, containmentOptions(ctx));
      let stat;
      try {
        stat = statSync(sourceDir);
      } catch {
        throw new Error(`skill_submit: path does not exist: ${sourceDir}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`skill_submit: path is not a directory: ${sourceDir}`);
      }

      const summary = (args as { summary?: unknown }).summary;
      const result = await lifecycle.submit({
        sourceDir,
        summary: typeof summary === 'string' && summary.trim() ? summary.trim() : undefined,
      });

      if (!result.ok) {
        return {
          ok: false,
          error: 'skill_validation_failed',
          message: 'Skill draft failed validation. Fix every error below and resubmit.',
          issues: result.issues,
        };
      }
      return {
        ok: true,
        submissionId: result.submission.submissionId,
        skillId: result.submission.skillId,
        status: result.submission.status,
        message:
          'Skill draft submitted for review. It becomes available after approval. ' +
          'Warnings (non-blocking, reviewers will see them): ' +
          (result.issues.length > 0 ? JSON.stringify(result.issues) : 'none'),
      };
    },
  };
}

function createSkillStatusTool(lifecycle: SkillLifecycle): RegisteredTool {
  return {
    definition: {
      name: 'skill_status',
      capabilities: ['fs-read'],
      description:
        'Check the review/enable status of submitted skills. Without arguments lists all skill registrations ' +
        'and pending review submissions; with skillId or submissionId returns that entry. ' +
        'Use after skill_submit to track review progress.',
      parameters: {
        skillId: { type: 'string', description: 'Skill id to look up (optional).' },
        submissionId: { type: 'string', description: 'Submission id to look up (optional).' },
      },
    },
    handler: async (args) => {
      const { skillId, submissionId } = args as { skillId?: string; submissionId?: string };

      if (submissionId) {
        const submissions = lifecycle.listSubmissions();
        const found = submissions.find((s) => s.submissionId === submissionId);
        if (!found) throw new Error(`skill_status: submission "${submissionId}" not found`);
        return { ...toPublicSubmission(found), findings: findingsOf(lifecycle, found.skillId) };
      }
      if (skillId) {
        const record = lifecycle.list().find((r) => r.skillId === skillId);
        if (!record) throw new Error(`skill_status: skill "${skillId}" is not registered`);
        return toPublicRecord(record);
      }
      return {
        skills: lifecycle.list().map(toPublicRecord),
        submissions: lifecycle.listSubmissions().map((s) => ({
          ...toPublicSubmission(s),
          findings: findingsOf(lifecycle, s.skillId),
        })),
      };
    },
  };
}

/** 对外登记视图（agent 面不暴露内部字段——stagingPath 等引擎路径不出工具输出） */
function toPublicRecord(record: {
  skillId: string;
  source: string;
  reviewStatus: string;
  enabled: boolean;
  contentHash: string;
  unreviewed: boolean;
  submissionId?: string;
  review?: { by: string; verdict: string; findings?: string; at: number };
  updatedAt: number;
}): Record<string, unknown> {
  return {
    skillId: record.skillId,
    source: record.source,
    reviewStatus: record.reviewStatus,
    enabled: record.enabled,
    contentHash: record.contentHash,
    unreviewed: record.unreviewed,
    submissionId: record.submissionId,
    lastReview: record.review
      ? { by: record.review.by, verdict: record.review.verdict, findings: record.review.findings, at: record.review.at }
      : undefined,
    updatedAt: record.updatedAt,
  };
}

/** 对外审查单视图（剥离 stagingPath——内部引擎路径不外泄） */
function toPublicSubmission(sub: {
  submissionId: string;
  skillId: string;
  summary?: string;
  status: string;
  issues: unknown[];
  createdAt: number;
  updatedAt: number;
}): Record<string, unknown> {
  return {
    submissionId: sub.submissionId,
    skillId: sub.skillId,
    summary: sub.summary,
    status: sub.status,
    issues: sub.issues,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  };
}

/** 最近审查 findings（驳回理由回传会话——设计 §4 行为契约） */
function findingsOf(lifecycle: SkillLifecycle, skillId: string): string | undefined {
  return lifecycle.list().find((r) => r.skillId === skillId)?.review?.findings;
}
