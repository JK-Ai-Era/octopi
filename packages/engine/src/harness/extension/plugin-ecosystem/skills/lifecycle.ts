/**
 * SkillLifecycle — 技能生命周期服务（arch/skill-creation-design.md §4–§6）
 *
 * 提交 / 审查 / 启停 / discover 准入判定的**单一实现**（one source of truth）：
 * skill_submit 工具、CLI、gateway REST 都只调本服务，不在各自路径重写语义。
 *
 * 安全边界（设计 §2 判断 1/2）：
 * - 提交物先复制进引擎区 staging（agent 不可写），审查对象 = staging 副本本体；
 * - 批准才物化到 `agents/<id>/skills/<id>/`；agent 无法伪造「已审查」状态；
 * - 审查绑定内容哈希：staging/物化后被改动 → 哈希漂移 → 审查作废重审。
 *
 * 准入语义（设计 §6.1，拍板 2026-11-25）：
 * - `skill_submit` 来源：须 approved 且 enabled 且哈希未漂移才进索引；
 * - dropped-in（host 直写/用户拷贝，不可区分）：放盘即信任，自动登记
 *   （unreviewed 标注）进索引；submitted 哈希漂移 = 审查作废回 pending（不进索引）。
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentHomeDir, assertPathSegment, sharedSkillsDir } from '../../../../paths.js';
import { parseSkillFile } from './frontmatter.js';
import { hashSkillDir } from './hash.js';
import {
  SkillStateDatabase,
  type SkillRecord,
  type SkillSubmission,
} from './registry.js';
import { validateSkillDir, type SkillIssue } from './validate.js';

// ── 类型 ──

/** discover 准入判定结果 */
export interface SkillAdmission {
  admitted: boolean;
  /** 放盘信任但未经审查（索引与审计面标注） */
  unreviewed?: boolean;
  /** 拒绝/降级原因（fail-loud 告警用） */
  reason?: string;
}

/** discover 准入闸门（DefaultSkillManager 依赖倒置；不感知 agentId 之外的业务） */
export interface SkillAdmissionGate {
  admit(input: { skillId: string; contentHash: string }): SkillAdmission;
}

export type SkillSubmitResult =
  | { ok: true; submission: SkillSubmission; issues: SkillIssue[] }
  | { ok: false; issues: SkillIssue[] };

/** 审查预览（对外 DTO；不含 stagingPath 等内部路径） */
export interface SkillSubmissionPreview {
  submissionId: string;
  skillId: string;
  summary?: string;
  status: SkillSubmission['status'];
  /** 登记的内容哈希（审查锚点） */
  contentHash: string;
  /** 静态校验 issues */
  issues: unknown[];
  /** staging 副本文件清单（bytes=-1 表示 symlink） */
  files: Array<{ path: string; bytes: number }>;
  /** SKILL.md 全文（staging 副本；缺失时 undefined） */
  skillMd?: string;
}

/** LLM 审查输入（提交包内容面） */
export interface LlmSkillReviewInput {
  skillId: string;
  skillMd: string;
  files: Array<{ path: string; bytes: number }>;
  issues: SkillIssue[];
}

/** LLM 审查结论 */
export interface LlmSkillReviewVerdict {
  verdict: 'approved' | 'rejected';
  findings?: string;
}

/**
 * LLM 审查通道（reviewPolicy='llm-gated' 时由宿主注入；如 gateway 起审查 run）。
 * 缺省无实现 = llm-gated 退化为 human（fail-closed，不静默自动批）。
 */
export interface SkillLlmReviewer {
  review(input: LlmSkillReviewInput): Promise<LlmSkillReviewVerdict>;
}

/** 技能审查策略（agents[].skillReviewPolicy；缺省 human） */
export type SkillReviewPolicy = 'human' | 'llm-gated' | 'auto';

export type SkillReviewResult =
  | { ok: true; record: SkillRecord; submissionId?: string }
  | { ok: false; error: string };

export interface SkillLifecycleOptions {
  db: SkillStateDatabase;
  /** OCTOPI_HOME（staging 与 agent home 物化路径派生） */
  octopiHome: string;
  agentId: string;
  /** 审查策略（agents[].skillReviewPolicy；缺省 human） */
  reviewPolicy?: SkillReviewPolicy;
  /** LLM 审查通道（llm-gated 用；缺省 = llm-gated 退化为 human，fail-closed） */
  llmReviewer?: SkillLlmReviewer;
}

// ── 实现 ──

export class SkillLifecycle implements SkillAdmissionGate {
  private readonly db: SkillStateDatabase;
  private readonly octopiHome: string;
  private readonly agentId: string;
  private readonly reviewPolicy: SkillReviewPolicy;
  private readonly llmReviewer?: SkillLlmReviewer;

  constructor(options: SkillLifecycleOptions) {
    this.db = options.db;
    this.octopiHome = options.octopiHome;
    this.agentId = options.agentId;
    this.reviewPolicy = options.reviewPolicy ?? 'human';
    this.llmReviewer = options.llmReviewer;
  }

  /** 审查对象的物化目标：agents/<id>/skills/<skillId>/ */
  private skillInstallDir(skillId: string): string {
    return join(agentHomeDir(this.octopiHome, this.agentId), 'skills', assertSkillId(skillId));
  }

  /**
   * 提交技能：静态校验 → staging 复制 → 审查单 + pending 登记。
   *
   * @param input.sourceDir - workspace 内起草目录（调用方已做路径 containment）
   * @param input.summary - 可选提交摘要（给审查者）
   * @returns 校验失败时 ok:false + 逐项 issues（agent 据此修复重提）
   */
  async submit(input: { sourceDir: string; summary?: string }): Promise<SkillSubmitResult> {
    const validation = validateSkillDir(input.sourceDir);
    if (!validation.ok) {
      return { ok: false, issues: validation.issues };
    }
    const skillId = assertSkillId(validation.meta?.name ?? '');

    // P1：同名已批准且启用的技能不可被一次提交顶下线（提交面 DoS / 审查记录抹除）。
    // 漂移重审路径不受影响——哈希漂移时 admit 已把该技能回 pending+disabled。
    const existing = this.db.getSkill(this.agentId, skillId);
    if (existing && existing.reviewStatus === 'approved' && existing.enabled) {
      return {
        ok: false,
        issues: [
          {
            severity: 'error',
            code: 'skill_already_active',
            field: skillId,
            message: `skill "${skillId}" is already approved and enabled; disable it first (octopi skill disable / skill管理面) before replacing it`,
          },
        ],
      };
    }

    const submissionId = randomUUID();
    const stagingPath = join(
      SkillStateDatabase.resolveStagingRoot(this.octopiHome),
      assertPathSegment(this.agentId, 'agent id'),
      submissionId,
    );
    const stagingSkillDir = join(stagingPath, skillId);
    await mkdir(stagingSkillDir, { recursive: true });
    await cp(input.sourceDir, stagingSkillDir, { recursive: true, force: true });

    // 审查对象 = staging 副本本体：对 staging 再校验（TOCTOU 收口——源目录在
    // 校验后被改动/插入 symlink 都不改变权威判定，且大小上限对副本同样生效）
    const stagingValidation = validateSkillDir(stagingSkillDir);
    if (!stagingValidation.ok) {
      await rm(stagingPath, { recursive: true, force: true });
      return { ok: false, issues: stagingValidation.issues };
    }

    const contentHash = hashSkillDir(stagingSkillDir);
    // 同名 shared 技能会被 agent 层「后层赢」覆盖——审查者必须看到这条
    const shadowWarn: SkillIssue[] = existsSync(join(sharedSkillsDir(this.octopiHome), skillId))
      ? [
          {
            severity: 'warning',
            code: 'shadows_shared_skill',
            field: skillId,
            message: 'a shared-layer skill with this id exists; approving will override it for this agent',
          },
        ]
      : [];
    const issues = [...stagingValidation.issues, ...shadowWarn];

    const submission = this.db.createSubmission({
      submissionId,
      agentId: this.agentId,
      skillId,
      stagingPath,
      summary: input.summary,
      issues,
    });
    this.db.upsertSkill({
      agentId: this.agentId,
      skillId,
      source: 'submitted',
      reviewStatus: 'pending',
      enabled: false,
      contentHash,
      unreviewed: false,
      submissionId,
      // 审查记录可追溯：保留历史审查记录（其 contentHash 锚点可辨版本），不抹除
      review: existing?.review,
    });

    // 审查策略分支（agents[].skillReviewPolicy；缺省 human = 现状等人工）
    if (this.reviewPolicy === 'auto') {
      // 开发用：跳过审查直接登记启用；审计留痕（by: policy:auto，不冒充人审）
      await this.review({
        skillId,
        verdict: 'approved',
        by: 'policy:auto',
        findings: 'auto-approved by skillReviewPolicy=auto (no review performed)',
      });
      // 返回态如实反映已批准（旧 submission 快照的 pending_review 会误导调用方）
      return { ok: true, submission: { ...submission, status: 'approved' }, issues };
    } else if (this.reviewPolicy === 'llm-gated' && this.llmReviewer) {
      // 异步 LLM 审查：不阻塞提交；结论自动回写（仅低风险通过才自动批）
      void this.runLlmReview(skillId, submissionId).catch((err) => {
        // LLM 审查失败 = 保持 pending 等人工（fail-closed），显式告警
        console.warn(
          `[Skills] llm review failed for "${skillId}" (stays pending for human review): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    // llm-gated 但无 llmReviewer = 退化 human（fail-closed，不静默自动批）

    return { ok: true, submission, issues };
  }

  /**
   * LLM 审查（llm-gated 策略的自动段）。自动批仅限低风险（拍板语义）：
   * LLM 通过 **且** 无 scripts/ **且** 无 allowed-tools 扩张；否则转人工
   *（LLM 结论留痕供人工参考，人终审可推翻）。
   */
  private async runLlmReview(skillId: string, submissionId: string): Promise<void> {
    const preview = await this.previewSubmission(submissionId);
    if (!preview?.skillMd) return;
    const verdict = await this.llmReviewer!.review({
      skillId,
      skillMd: preview.skillMd,
      files: preview.files,
      issues: preview.issues as SkillIssue[],
    });

    // low-risk 判定收紧（P2）：大小写不敏感、任意层级的 scripts/ 段都算脚本
    //（`Scripts/`、`a/scripts/x` 曾可绕过自动批的脚本边界）
    const hasScripts = preview.files.some((f) =>
      f.path.split('/').some((seg) => seg.toLowerCase() === 'scripts'),
    );
    const hasToolExpansion = Boolean(parseSkillFile(preview.skillMd)?.meta.allowedTools?.length);
    const lowRisk = !hasScripts && !hasToolExpansion;

    if (verdict.verdict === 'approved' && lowRisk) {
      // 锚点绑定（P0）：只对被审的这一代 submission 生效——审查期间同名重提
      // 不得借旧包的 lowRisk 混过自动批
      const result = await this.review({
        skillId,
        verdict: 'approved',
        by: 'llm-gated',
        findings: verdict.findings,
        expectedSubmissionId: submissionId,
      });
      if (!result.ok) {
        console.warn(
          `[Skills] llm-gated auto-approve refused for "${skillId}" (stays pending for human): ${result.error}`,
        );
      }
      return;
    }
    // 转人工：保持 pending；LLM 结论留痕（by 显式标注是机器审，不冒充人审）。
    // 绑定当前代 submission：记录换代（同名重提）则不写——留痕不得挂到没见过的包上
    const record = this.db.getSkill(this.agentId, skillId);
    if (record && record.reviewStatus === 'pending' && record.submissionId === submissionId) {
      this.db.upsertSkill({
        ...record,
        review: {
          by: 'llm-gated',
          verdict: verdict.verdict,
          findings:
            verdict.findings ??
            (lowRisk ? 'llm rejected' : `llm verdict=${verdict.verdict}; low-risk auto-approve not applicable (scripts/ or allowed-tools present) — human review required`),
          at: Date.now(),
          contentHash: record.contentHash,
        },
      });
    }
  }

  /**
   * 审查裁决。approved 时把 staging 副本物化到 agent skills 目录并默认启用。
   *
   * @param input.skillId - 技能 id
   * @param input.verdict - approved | rejected
   * @param input.by - 审查者（'human:<user>' / 'llm:<model>'）
   * @param input.findings - 审查意见（驳回时回传会话）
   * @returns 裁决后的登记条目；pending 提交不存在时 ok:false
   */
  async review(input: {
    skillId: string;
    verdict: 'approved' | 'rejected';
    by: string;
    findings?: string;
    /**
     * 审查锚点：裁决只对这个 submission 代生效（P0 竞态防线）。
     * 预览/审查期间同名重提会让 record 换代——不锚定就会「审 A 批 B」
     *（LLM 按旧包判的 lowRisk，被用来自动批一个带 scripts 的新包）。
     */
    expectedSubmissionId?: string;
  }): Promise<SkillReviewResult> {
    const skillId = assertSkillId(input.skillId);
    const record = this.db.getSkill(this.agentId, skillId);
    if (!record) return { ok: false, error: `skill "${skillId}" is not registered` };
    if (record.reviewStatus !== 'pending') {
      return {
        ok: false,
        error: `skill "${skillId}" is not pending review (status: ${record.reviewStatus})`,
      };
    }
    // 锚点校验（P0）：裁决必须指向审查者看过的那个 submission 代
    if (
      input.expectedSubmissionId !== undefined &&
      record.submissionId !== input.expectedSubmissionId
    ) {
      return {
        ok: false,
        error: `review_conflict: submission changed since it was inspected (expected ${input.expectedSubmissionId}, current ${record.submissionId ?? 'none'}) — re-inspect the new submission and decide again`,
      };
    }

    const review = {
      by: input.by,
      verdict: input.verdict,
      findings: input.findings,
      at: Date.now(),
      contentHash: record.contentHash,
    };

    if (input.verdict === 'rejected') {
      const rejected: SkillRecord = { ...record, reviewStatus: 'rejected', enabled: false, review };
      this.db.upsertSkill(rejected);
      if (record.submissionId) this.db.updateSubmissionStatus(record.submissionId, 'rejected');
      return { ok: true, record: rejected, submissionId: record.submissionId };
    }

    // approved：staging 是唯一物化来源（审查对象本体）。双重锚点校验（P1）：
    // 无 staging 或哈希与登记不符（staging 被偷改 / 漂移后旧 staging 冒充新内容）
    // 一律 fail-loud 要求重新提交——绝不拿未审查内容物化、不 rm 掉磁盘上更新的版本。
    const submission = record.submissionId ? this.db.getSubmission(record.submissionId) : null;
    const stagingSkillDir = submission ? join(submission.stagingPath, skillId) : undefined;
    if (!stagingSkillDir || !existsSync(stagingSkillDir)) {
      return {
        ok: false,
        error: `staging copy missing for "${skillId}" — the skill must be resubmitted via skill_submit (staging_changed_since_submit)`,
      };
    }
    if (hashSkillDir(stagingSkillDir) !== record.contentHash) {
      return {
        ok: false,
        error: `staging copy does not match the audited hash for "${skillId}" — resubmit via skill_submit (staging_changed_since_submit)`,
      };
    }
    // 先删后拷：cp 覆盖不清残片（旧版独有的文件会留下——并发写纪律的残片风险），
    // 物化必须让目标目录与审查过的 staging 副本逐字节一致
    await rm(this.skillInstallDir(skillId), { recursive: true, force: true });
    await cp(stagingSkillDir, this.skillInstallDir(skillId), {
      recursive: true,
      force: true,
    });

    const approved: SkillRecord = {
      ...record,
      reviewStatus: 'approved',
      enabled: true,
      unreviewed: false,
      review,
    };
    this.db.upsertSkill(approved);
    if (record.submissionId) this.db.updateSubmissionStatus(record.submissionId, 'approved');
    return { ok: true, record: approved, submissionId: record.submissionId };
  }

  /**
   * 启停开关（运维维度；disable = 出事一键下线）。
   *
   * @param skillId - 技能 id
   * @param enabled - 目标状态
   * @returns 更新后登记条目
   */
  setEnabled(skillId: string, enabled: boolean): SkillRecord {
    const id = assertSkillId(skillId);
    const record = this.db.getSkill(this.agentId, id);
    if (!record) throw new Error(`skill "${id}" is not registered`);
    if (enabled && record.reviewStatus !== 'approved') {
      throw new Error(`skill "${id}" is not approved (status: ${record.reviewStatus}); cannot enable`);
    }
    const updated: SkillRecord = { ...record, enabled };
    this.db.upsertSkill(updated);
    return updated;
  }

  /**
   * discover 准入判定（SkillAdmissionGate）。
   *
   * 语义（设计 §6.1）：
   * - 未登记 → dropped-in 自动登记（放盘即信任，unreviewed 标注）→ 准入；
   * - 已登记且哈希漂移：
   *   - submitted → 审查作废回 pending（不进索引，reason=stale_hash）；
   *   - dropped-in → 放盘信任延续，刷新哈希 → 准入（unreviewed）；
   * - approved + enabled + 哈希一致 → 准入；其余（pending/rejected/disabled）→ 拒。
   *
   * @param input.skillId - 技能 id
   * @param input.contentHash - 发现时计算的目录内容哈希
   * @returns 准入判定
   */
  admit(input: { skillId: string; contentHash: string }): SkillAdmission {
    // 发现输入边界：磁盘目录名不可控（放盘来源可含下划线/大写/非 ASCII），
    // 非法 id 拒而不抛——抛出会中止整个 discover（一个坏目录打掉全部技能面
    // 并触发 wire 降级为无闸门兜底，fail-open）。路径构造处仍用 assertSkillId。
    let skillId: string;
    try {
      skillId = assertSkillId(input.skillId);
    } catch {
      return { admitted: false, reason: 'invalid_skill_id' };
    }
    const record = this.db.getSkill(this.agentId, skillId);

    if (!record) {
      this.db.upsertSkill({
        agentId: this.agentId,
        skillId,
        source: 'dropped-in',
        reviewStatus: 'approved',
        enabled: true,
        contentHash: input.contentHash,
        unreviewed: true,
      });
      return { admitted: true, unreviewed: true, reason: 'auto_enrolled_dropped_in' };
    }

    const hashDrifted = record.contentHash !== input.contentHash;
    if (hashDrifted) {
      if (record.source === 'submitted') {
        // 审查的是内容不是名字：内容变了旧审查作废，回 pending 重审（fail-closed）。
        // 旧 submission 一并作废（清锚点）：staging 是旧内容，不得再被当审查对象
        // 物化（否则批准会用旧内容覆盖磁盘新版本且永不收敛——P1 死循环形态）
        this.db.upsertSkill({
          ...record,
          reviewStatus: 'pending',
          enabled: false,
          contentHash: input.contentHash,
          submissionId: undefined,
        });
        return { admitted: false, reason: 'stale_hash_resubmit_required' };
      }
      // dropped-in：放盘信任延续（本就 unreviewed），刷新哈希
      this.db.upsertSkill({ ...record, contentHash: input.contentHash });
      return { admitted: true, unreviewed: true, reason: 'dropped_in_hash_refreshed' };
    }

    if (record.reviewStatus !== 'approved') {
      return { admitted: false, reason: `review_status_${record.reviewStatus}` };
    }
    if (!record.enabled) {
      return { admitted: false, reason: 'disabled' };
    }
    return { admitted: true, unreviewed: record.unreviewed };
  }

  /**
   * 删除已装技能目录 + 登记（rejected 修订重提前的清理；谨慎调用）。
   *
   * @param skillId - 技能 id
   * @returns 是否发生删除
   */
  async removeInstalled(skillId: string): Promise<boolean> {
    const id = assertSkillId(skillId);
    const record = this.db.getSkill(this.agentId, id);
    if (!record) return false;
    await rm(this.skillInstallDir(id), { recursive: true, force: true });
    this.db.upsertSkill({ ...record, enabled: false });
    return true;
  }

  /** 全量技能登记（CLI/REST 列表面） */
  list(): SkillRecord[] {
    return this.db.listSkills(this.agentId);
  }

  /** 审查单列表（审查队列面） */
  listSubmissions(status?: SkillSubmission['status']): SkillSubmission[] {
    return this.db.listSubmissions(this.agentId, status);
  }

  /**
   * 审查预览（设计 §5「列表 → 预览/diff → 裁决」的内容面）。
   *
   * 返回 staging 副本的文件清单 + SKILL.md 全文 + 哈希锚点；
   * **不外泄 stagingPath**（内部引擎路径不出现在对外 DTO）。
   *
   * @param submissionId - 审查单 id
   * @returns 预览；不存在/非本 agent 时 null
   */
  async previewSubmission(submissionId: string): Promise<SkillSubmissionPreview | null> {
    const sub = this.db.getSubmission(submissionId);
    if (!sub || sub.agentId !== this.agentId) return null;
    const stagingSkillDir = join(sub.stagingPath, sub.skillId);

    const files: Array<{ path: string; bytes: number }> = [];
    let skillMd: string | undefined;
    const walk = (dir: string, prefix: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) {
          files.push({ path: rel, bytes: -1 }); // -1 = symlink（validate 已拒；预览如实呈现）
          continue;
        }
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), rel);
          continue;
        }
        const abs = join(dir, entry.name);
        let bytes = 0;
        try {
          bytes = statSync(abs).size;
          if (rel === 'SKILL.md') skillMd = readFileSync(abs, 'utf-8');
        } catch {
          // 单文件读失败在预览里可见（bytes 保持 0），不拖垮整份预览
        }
        files.push({ path: rel, bytes });
      }
    };
    if (existsSync(stagingSkillDir)) walk(stagingSkillDir, '');

    const record = this.db.getSkill(this.agentId, sub.skillId);
    return {
      submissionId: sub.submissionId,
      skillId: sub.skillId,
      summary: sub.summary,
      status: sub.status,
      contentHash: record?.contentHash ?? '',
      issues: sub.issues,
      files,
      skillMd,
    };
  }
}

/**
 * skill id 安全断言：形态必须合法（= 目录名段防穿越）。
 *
 * @param skillId - 候选 skill id
 * @returns 原值
 * @throws 形态非法时抛错
 */
export function assertSkillId(skillId: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillId) || skillId.length > 64) {
    throw new Error(`invalid skill id: ${JSON.stringify(skillId)}`);
  }
  return skillId;
}
