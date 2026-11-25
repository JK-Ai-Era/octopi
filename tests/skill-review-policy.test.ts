import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SkillStateDatabase,
  type SkillRecord,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/registry.js';
import {
  SkillLifecycle,
  type LlmSkillReviewVerdict,
  type SkillLlmReviewer,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/lifecycle.js';

describe('skills.reviewPolicy', () => {
  let home: string;
  let db: SkillStateDatabase;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'skill-policy-'));
    db = await SkillStateDatabase.create({ dbPath: ':memory:' });
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function makeSkill(id: string, opts?: { scripts?: boolean }): string {
    const dir = join(home, 'drafts', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${id}\ndescription: Does ${id} things. Use when needed.\n---\nBody of ${id}.`,
    );
    if (opts?.scripts) {
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(join(dir, 'scripts', 'run.js'), 'console.log("hi");');
    }
    return dir;
  }

  function find(db2: SkillStateDatabase, id: string): SkillRecord {
    return db2.listSkills('a1').find((r) => r.skillId === id)!;
  }

  test('auto：submit 即批准启用，审计留痕 policy:auto（不冒充人审）', async () => {
    const lifecycle = new SkillLifecycle({
      db,
      octopiHome: home,
      agentId: 'a1',
      reviewPolicy: 'auto',
    });
    const result = await lifecycle.submit({ sourceDir: makeSkill('quick') });
    expect(result.ok).toBe(true);
    const record = find(db, 'quick');
    expect(record.reviewStatus).toBe('approved');
    expect(record.enabled).toBe(true);
    expect(record.review!.by).toBe('policy:auto');
  });

  test('llm-gated + LLM 通过 + 低风险（无 scripts/无 allowed-tools）→ 自动批', async () => {
    const reviewer: SkillLlmReviewer = {
      async review(): Promise<LlmSkillReviewVerdict> {
        return { verdict: 'approved', findings: 'clean' };
      },
    };
    const lifecycle = new SkillLifecycle({
      db,
      octopiHome: home,
      agentId: 'a1',
      reviewPolicy: 'llm-gated',
      llmReviewer: reviewer,
    });
    const result = await lifecycle.submit({ sourceDir: makeSkill('clean') });
    expect(result.ok).toBe(true);
    await waitFor(() => find(db, 'clean')?.reviewStatus === 'approved');
    const record = find(db, 'clean');
    expect(record.enabled).toBe(true);
    expect(record.review!.by).toBe('llm-gated');
    expect(record.review!.findings).toBe('clean');
  });

  test('llm-gated + LLM 通过但含 scripts/ → 转人工（pending + LLM 留痕）', async () => {
    const reviewer: SkillLlmReviewer = {
      async review(): Promise<LlmSkillReviewVerdict> {
        return { verdict: 'approved', findings: 'looks fine to me' };
      },
    };
    const lifecycle = new SkillLifecycle({
      db,
      octopiHome: home,
      agentId: 'a1',
      reviewPolicy: 'llm-gated',
      llmReviewer: reviewer,
    });
    const result = await lifecycle.submit({ sourceDir: makeSkill('with-scripts', { scripts: true }) });
    expect(result.ok).toBe(true);
    await waitFor(() => Boolean(find(db, 'with-scripts')?.review));
    const record = find(db, 'with-scripts');
    // 含 scripts 不得自动批：保持 pending，LLM 结论留痕供人工参考
    expect(record.reviewStatus).toBe('pending');
    expect(record.enabled).toBe(false);
    expect(record.review!.by).toBe('llm-gated');
    expect(record.review!.findings).toContain('looks fine to me');
  });

  test('llm-gated + LLM 拒绝 → 转人工（人终审可推翻，不自动拒）', async () => {
    const reviewer: SkillLlmReviewer = {
      async review(): Promise<LlmSkillReviewVerdict> {
        return { verdict: 'rejected', findings: 'suspicious exfil pattern' };
      },
    };
    const lifecycle = new SkillLifecycle({
      db,
      octopiHome: home,
      agentId: 'a1',
      reviewPolicy: 'llm-gated',
      llmReviewer: reviewer,
    });
    await lifecycle.submit({ sourceDir: makeSkill('sketchy') });
    await waitFor(() => Boolean(find(db, 'sketchy')?.review));
    const record = find(db, 'sketchy');
    expect(record.reviewStatus).toBe('pending'); // 不自动拒，人终审
    expect(record.review!.findings).toContain('suspicious');
  });

  test('llm-gated + reviewer 抛错 → 保持 pending（fail-closed 转人工）', async () => {
    const reviewer: SkillLlmReviewer = {
      async review(): Promise<LlmSkillReviewVerdict> {
        throw new Error('provider down');
      },
    };
    const lifecycle = new SkillLifecycle({
      db,
      octopiHome: home,
      agentId: 'a1',
      reviewPolicy: 'llm-gated',
      llmReviewer: reviewer,
    });
    await lifecycle.submit({ sourceDir: makeSkill('unlucky') });
    await sleep(20); // 异步审查已跑完（失败）
    const record = find(db, 'unlucky');
    expect(record.reviewStatus).toBe('pending');
    expect(record.enabled).toBe(false);
  });

  test('llm-gated 但无 reviewer → 退化 human（不静默自动批）', async () => {
    const lifecycle = new SkillLifecycle({
      db,
      octopiHome: home,
      agentId: 'a1',
      reviewPolicy: 'llm-gated',
    });
    await lifecycle.submit({ sourceDir: makeSkill('guarded') });
    await sleep(20);
    const record = find(db, 'guarded');
    expect(record.reviewStatus).toBe('pending');
    expect(record.review).toBeUndefined();
  });

  test('human（缺省）：submit 保持 pending 等人工', async () => {
    const lifecycle = new SkillLifecycle({ db, octopiHome: home, agentId: 'a1' });
    await lifecycle.submit({ sourceDir: makeSkill('manual') });
    const record = find(db, 'manual');
    expect(record.reviewStatus).toBe('pending');
    expect(record.enabled).toBe(false);
  });

  test('P0 竞态回归：审查在飞期间同名重提，旧结论不得放行新包', async () => {
    let resolveReview!: (v: LlmSkillReviewVerdict) => void;
    const reviewer: SkillLlmReviewer = {
      review: () =>
        new Promise<LlmSkillReviewVerdict>((r) => {
          resolveReview = r;
        }),
    };
    const lifecycle = new SkillLifecycle({
      db,
      octopiHome: home,
      agentId: 'a1',
      reviewPolicy: 'llm-gated',
      llmReviewer: reviewer,
    });
    // A：纯指令包（低风险）——LLM 审查挂起在飞
    await lifecycle.submit({ sourceDir: makeSkill('hot') });
    // B：同名重提，带 scripts（pending 允许覆盖 = 攻击链前提）
    await lifecycle.submit({ sourceDir: makeSkill('hot', { scripts: true }) });
    // A 的 approved 到达：必须因锚点不符被拒（否则 B 借 A 的 lowRisk 自动上线）
    resolveReview({ verdict: 'approved', findings: 'clean' });
    await sleep(30);
    const record = find(db, 'hot');
    expect(record.reviewStatus).toBe('pending');
    expect(record.enabled).toBe(false);
  });

  test('人工裁决锚点：expectedSubmissionId 换代即 conflict', async () => {
    const lifecycle = new SkillLifecycle({ db, octopiHome: home, agentId: 'a1' });
    const first = await lifecycle.submit({ sourceDir: makeSkill('anchor') });
    const staleId = first.ok ? first.submission.submissionId : '';
    // 同名重提换代
    await lifecycle.submit({ sourceDir: makeSkill('anchor') });
    const conflict = await lifecycle.review({
      skillId: 'anchor',
      verdict: 'approved',
      by: 'human:t',
      expectedSubmissionId: staleId,
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.ok === false && conflict.error).toContain('review_conflict');
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(5);
  }
}
