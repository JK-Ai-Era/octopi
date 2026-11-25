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
import { statSync, readFileSync } from 'node:fs';
import {
  containmentOptions,
  resolveToolPath,
} from './platform.js';
import type { SkillLifecycle } from '../skills/lifecycle.js';
import { DEFAULT_READ_LIMIT, MAX_READ_LIMIT } from '../skills/manager.js';
import type { SkillFileEntry, SkillLoadResult, SkillManager } from '../skills/types.js';

/** 工具 handler 的 containment 上下文（与 file-ops 同形） */
interface SkillToolContext {
  cwd?: string;
  pathRoots?: string[];
  pathContainment?: 'strict' | 'soft' | 'none';
}

export interface SkillToolOptions {
  lifecycle: SkillLifecycle;
  /**
   * 技能消费面单源（skill_read 的正文/清单/附件读取）。
   * provider 形态：工具注册发生在 buildCore 前（Agent 构造时快照 tools），
   * 而 manager 在其后 discover——handler 运行期解析，未就绪即 fail-loud。
   */
  skills: SkillManager | (() => SkillManager | undefined);
}

/**
 * 创建 skill_submit / skill_status / skill_read / skill_run 工具
 *
 * @param options - SkillLifecycle（提交/查询的单一实现）+ SkillManager（读取/执行消费面）
 * @returns 工具注册数组
 */
export function createSkillTools(options: SkillToolOptions): RegisteredTool[] {
  return [
    ...createSkillLifecycleTools(options.lifecycle),
    ...createSkillConsumptionTools(options.skills),
  ];
}

/**
 * lifecycle 面工具（skill_submit / skill_status）——需要 SkillLifecycle。
 *
 * @param lifecycle - 提交/查询的单一实现
 * @returns 工具注册数组
 */
export function createSkillLifecycleTools(lifecycle: SkillLifecycle): RegisteredTool[] {
  return [createSkillSubmitTool(lifecycle), createSkillStatusTool(lifecycle)];
}

/**
 * 消费面工具（skill_read / skill_run）——只要 SkillManager（provider），
 * 不绑 lifecycle（F10：嵌入式/无 skill-state 部署同样要有消费面）。
 *
 * @param skills - SkillManager 或懒 provider（注册先于 discover 时用 provider）
 * @returns 工具注册数组
 */
export function createSkillConsumptionTools(
  skills: SkillManager | (() => SkillManager | undefined),
): RegisteredTool[] {
  return [createSkillReadTool(skills), createSkillRunTool(skills)];
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

/**
 * skill_read — 技能按需读取面（设计 §12.3）。
 *
 * 两分支：
 * - 不给 file：SKILL.md 正文 + 附件清单一次给出（正文截断带续读指针；
 *   清单条目带首行提要，上限外「+N more」如实标注）；
 * - 给 file：该附件内容（offset/limit 分段）。
 * 读取走 SkillManager 单源（审查哈希锚定 + 二次 containment 都在其内）。
 */
function createSkillReadTool(
  skills: SkillManager | (() => SkillManager | undefined),
): RegisteredTool {
  const resolveManager = (): SkillManager => {
    const mgr = typeof skills === 'function' ? skills() : skills;
    if (!mgr) {
      throw new Error(
        'skill_read: skill index is not ready (discover has not run for this agent yet)',
      );
    }
    return mgr;
  };
  return {
    definition: {
      name: 'skill_read',
      capabilities: ['fs-read'],
      description:
        'Read a skill bundle on demand: without `file`, returns the SKILL.md body plus an attachment listing ' +
        '(name/size/first-line excerpt) in one call; with `file`, returns that attachment (use offset/limit for long files). ' +
        'Only skills visible in the skills index are readable; content changed after review is refused (hash drift). ' +
        'Skills are a read-only namespace — do NOT expect their files via file_read/file_search.',
      parameters: {
        id: {
          type: 'string',
          description: 'Skill id from the skills index.',
          required: true,
        },
        file: {
          type: 'string',
          description:
            'Attachment path inside the skill (e.g. "references/spec-reference.md"). Omit for SKILL.md body + file listing.',
        },
        offset: {
          type: 'number',
          description: 'Start line for file content (1-indexed, default 1).',
        },
        limit: {
          type: 'number',
          description: 'Max lines to return (default 2000).',
        },
      },
    },
    handler: async (args) => {
      const mgr = resolveManager();
      const id = (args as { id?: unknown }).id;
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error('skill_read: "id" (string) is required');
      }
      const skillId = id.trim();

      const fileArg = (args as { file?: unknown }).file;
      const file = typeof fileArg === 'string' && fileArg.trim() ? fileArg.trim() : undefined;
      const offset = (args as { offset?: unknown }).offset;
      const limit = (args as { limit?: unknown }).limit;
      const opts = {
        ...(typeof offset === 'number' ? { offset } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
      };

      // file= 分支：附件内容（SKILL.md 也归此分支——复用正文单源，剥 frontmatter）
      if (file) {
        const isSkillMd = file.replace(/^\.\//, '') === 'SKILL.md';
        const result = isSkillMd
          ? await asFileResult(mgr.load(skillId), opts)
          : await mgr.loadFile(skillId, file, opts);
        if (result.status === 'not_found') {
          throw new Error(
            `skill_read: "${skillId}" or "${file}" not found (missing, disabled, or not admitted)`,
          );
        }
        if (result.status === 'refused') {
          // 拒绝分类报因（F12）：漂移≠停用≠未过审，文案不误导
          throw new Error(`skill_read: ${skillId}: ${result.reason}`);
        }
        if (result.status === 'path_forbidden') {
          throw new Error(`skill_read: forbidden path "${file}": ${result.reason}`);
        }
        if (result.status === 'binary') {
          throw new Error(
            `skill_read: "${file}" is a binary file — contents are not readable as text`,
          );
        }
        return {
          skill: skillId,
          file,
          content: result.content,
          fromLine: result.fromLine,
          toLine: result.toLine,
          totalLines: result.totalLines,
          truncated: result.truncated,
          ...(result.outOfRange ? { outOfRange: true } : {}),
          ...(result.truncated
            ? {
                hint: `continue with skill_read(id="${skillId}", file="${file}", offset=${result.toLine + 1})`,
              }
            : {}),
        };
      }

      // 默认分支：SKILL.md 正文 + 附件清单
      const loaded = await mgr.load(skillId);
      if (loaded.status === 'not_found') {
        throw new Error(
          `skill_read: skill "${skillId}" not found (missing, disabled, or not admitted)`,
        );
      }
      if (loaded.status === 'refused') {
        throw new Error(`skill_read: ${skillId}: ${loaded.reason}`);
      }
      const listing = await mgr.listFiles(skillId);
      const lines = loaded.body.split('\n');
      // 默认分支只从头截（offset/limit 分段归 file='SKILL.md' 续读分支）
      const maxLines = Math.min(
        Math.max(1, Math.floor(opts.limit ?? DEFAULT_READ_LIMIT)),
        MAX_READ_LIMIT,
      );
      const bodyLines = lines.slice(0, maxLines);
      const bodyTruncated = bodyLines.length < lines.length;
      return {
        skill: skillId,
        body: bodyLines.join('\n'),
        totalLines: loaded.totalLines,
        truncated: bodyTruncated,
        ...(bodyTruncated
          ? {
              hint: `body truncated — continue with skill_read(id="${skillId}", file="SKILL.md", offset=${bodyLines.length + 1})`,
            }
          : {}),
        unreviewed: loaded.unreviewed,
        files: listing?.entries ?? [],
        filesTotal: listing?.total ?? 0,
        filesOmitted: Math.max(0, (listing?.total ?? 0) - (listing?.entries.length ?? 0)),
        // F14：清单走查失败如实透传，不静默显示 0 附件
        ...(listing?.error ? { filesError: listing.error } : {}),
      };
    },
  };
}

/** load() 结果 → 附件读取形态（file='SKILL.md' 分支复用正文单源后统一渲染） */
async function asFileResult(
  loadedPromise: Promise<SkillLoadResult>,
  opts: { offset?: number; limit?: number },
): Promise<import('../skills/types.js').SkillFileLoadResult> {
  const loaded = await loadedPromise;
  if (loaded.status !== 'ok') return loaded;
  const lines = loaded.body.split('\n');
  const totalLines = loaded.totalLines;
  const offset = Math.max(1, Math.floor(opts.offset ?? 1));
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_READ_LIMIT)), MAX_READ_LIMIT);
  if (offset > totalLines && totalLines > 0) {
    return {
      status: 'ok',
      content: '',
      totalLines,
      fromLine: offset,
      toLine: offset - 1,
      truncated: false,
      outOfRange: true,
      fileHash: loaded.fileHash,
    };
  }
  const fromLine = Math.max(1, Math.min(offset, Math.max(totalLines, 1)));
  const toLine = Math.min(fromLine + limit - 1, totalLines);
  return {
    status: 'ok',
    content: lines.slice(fromLine - 1, toLine).join('\n'),
    totalLines,
    fromLine,
    toLine,
    truncated: toLine < totalLines,
    fileHash: loaded.fileHash,
  };
}

// ── skill_run 执行面（S1 §12.4） ──

/**
 * 扩展名 → 解释器 argv（三级解析的兜底级）。
 * `.bat`/`.cmd` 有意不支持：`cmd /c` + argv 拼接是命令注入面（CVE-2024-27980），
 * 与 platform.ts 的「宁可 throw 也不 spawn .cmd」立场一致（F9）。
 */
const EXT_INTERPRETERS: Record<string, string[]> = {
  '.py': ['python3'],
  '.js': ['node'],
  '.sh': ['bash'],
  '.ps1': ['pwsh'],
  '.rb': ['ruby'],
  '.pl': ['perl'],
  '.lua': ['lua'],
};

/** 扩展名 → 解释器 argv 头的空白分词（F11：`python3 -u` 形态拆 argv；引号不支持=按字面） */
function tokenizeSpec(spec: string): string[] {
  return spec.trim().split(/\s+/).filter(Boolean);
}

/**
 * 解释器三级解析（§12.4）：shebang（脚本文本首行）→ metadata.interpreter → 扩展名映射。
 * 解析不到 = fail loud（「加 shebang 或 metadata.interpreter」），不猜不降级。
 *
 * @param scriptText - 脚本文本（与执行字节同源；F3）
 * @param declared - frontmatter metadata.interpreter
 * @param scriptPathForExt - 扩展名映射的判定源（原技能内路径）
 * @returns 解释器 argv 头（[exe, ...fixedArgs]），或错误原因
 */
function resolveInterpreter(
  scriptText: string,
  declared: string | undefined,
  scriptPathForExt: string,
): { argv: string[] } | { error: string } {
  // 1) shebang（脚本自声明优先——作者意图最准）
  const line = scriptText.split('\n', 1)[0] ?? '';
  const m = line.match(/^#!\s*(\S+)(?:\s+(.*))?/);
  if (m) {
    const exe = m[1]!;
    const rest = tokenizeSpec(m[2] ?? '');
    // `#!/usr/bin/env X ...` 形态：剥 env（含 `env -S` 多参透传），直接用其后 token
    if (/\/env$/.test(exe)) {
      const effective = rest[0] === '-S' ? rest.slice(1) : rest;
      if (effective.length > 0) return { argv: effective };
    }
    return { argv: [exe, ...rest] };
  }
  // 2) frontmatter metadata.interpreter（空白分词：`python3 -u` → argv 头）
  if (declared?.trim()) {
    const tokens = tokenizeSpec(declared);
    if (tokens.length > 0) return { argv: tokens };
  }
  // 3) 扩展名映射
  const dot = scriptPathForExt.lastIndexOf('.');
  const ext = dot >= 0 ? scriptPathForExt.slice(dot).toLowerCase() : '';
  if (ext === '.bat' || ext === '.cmd') {
    return {
      error:
        '.bat/.cmd scripts are not supported (cmd /c argv-splicing is a command-injection surface, CVE-2024-27980) — ' +
        'port the script to a supported interpreter',
    };
  }
  const mapped = EXT_INTERPRETERS[ext];
  if (mapped) return { argv: [...mapped] };
  return {
    error:
      'cannot determine interpreter — add a shebang line, set metadata.interpreter in SKILL.md frontmatter, ' +
      `or use a known extension (${Object.keys(EXT_INTERPRETERS).join(', ')})`,
  };
}

/**
 * skill_run — 技能脚本执行面（§12.4）。
 *
 * - 执行闭合（F3）：脚本字节取自 {@link SkillManager.consume} 单 IO 快照（与
 *   锚定哈希同源），写入临时副本后执行副本——**执行的字节 = 通过锚定的字节**；
 * - 二次 containment（快照 key 归一 + `..`/绝对路径拒绝；symlink 不入快照）；
 * - 复用 ProcessSandbox：jail 只读根 = 技能目录（脚本改不了自己），写根 = workspace
 *   （产出落工作区进 shell journal 账本——F8）；cwd = workspace；
 * - gateEffect kind:'runner'（dedicated allowlisted execution，不受 shellEscape 闸
 *   ——拍板 §12.7-1 技能面自成命名空间；host-gate 通道仍走确认闸）+
 *   ops.command.executed 审计（含 unreviewed/jail 标注）。
 */
function createSkillRunTool(
  skills: SkillManager | (() => SkillManager | undefined),
): RegisteredTool {
  const resolveManager = (): SkillManager => {
    const mgr = typeof skills === 'function' ? skills() : skills;
    if (!mgr) {
      throw new Error(
        'skill_run: skill index is not ready (discover has not run for this agent yet)',
      );
    }
    return mgr;
  };
  return {
    definition: {
      name: 'skill_run',
      capabilities: ['exec'],
      description:
        'Run a script from a skill bundle (scripts/ or any file inside the bundle). ' +
        'The interpreter is resolved from the script shebang, then metadata.interpreter, then the file extension ' +
        '(python3/node/bash/pwsh/ruby/perl/lua; .bat/.cmd are refused). The skill directory is mounted read-only ' +
        '(enforced on Linux bwrap; on macOS Seatbelt write-denial depends on the deployment) — the script cannot ' +
        'modify itself; outputs land in the workspace. Only reviewed+enabled skills are runnable; content changed ' +
        'after review is refused (hash drift). Prefer this over shell for skill scripts.',
      timeoutMs: 600_000,
      parameters: {
        id: {
          type: 'string',
          description: 'Skill id from the skills index.',
          required: true,
        },
        script: {
          type: 'string',
          description: 'Script path inside the skill (e.g. "scripts/run.sh").',
          required: true,
        },
        args: {
          type: 'array',
          description: 'Arguments passed to the script (array of strings).',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default 60000, max 598000).',
        },
      },
    },
    handler: async (args, context) => {
      const mgr = resolveManager();
      const id = (args as { id?: unknown }).id;
      const script = (args as { script?: unknown }).script;
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error('skill_run: "id" (string) is required');
      }
      if (typeof script !== 'string' || !script.trim()) {
        throw new Error('skill_run: "script" (string) is required');
      }
      const skillId = id.trim();
      const skill = mgr.get(skillId);
      if (!skill) {
        throw new Error(
          `skill_run: skill "${skillId}" not found (missing, disabled, or not admitted)`,
        );
      }

      // 单 IO 快照：脚本字节与锚定哈希同源（执行闭合的前提）
      const consumed = mgr.consume(skillId);
      if (!consumed.ok) {
        throw new Error(
          consumed.status === 'not_found'
            ? `skill_run: skill "${skillId}" not found (missing, disabled, or not admitted)`
            : `skill_run: ${skillId}: ${consumed.reason}`,
        );
      }

      // 二次 containment：快照 key 归一 `/`；拒绝对路径与 `..`（symlink 不入快照）
      const cleaned = script.trim().replace(/\\/g, '/');
      if (!cleaned || cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) {
        throw new Error(
          `skill_run: forbidden script path "${script}": absolute paths are not allowed`,
        );
      }
      if (cleaned.split('/').includes('..')) {
        throw new Error(
          `skill_run: forbidden script path "${script}": path traversal ("..") is not allowed`,
        );
      }
      const scriptBytes = consumed.files.get(cleaned);
      if (!scriptBytes) {
        if (consumed.skippedSymlinks.has(cleaned)) {
          throw new Error(
            `skill_run: forbidden script path "${script}": symbolic links are not consumed (path-containment risk)`,
          );
        }
        throw new Error(`skill_run: script "${script}" not found in skill "${skillId}"`);
      }
      if (scriptBytes.length > 1024 * 1024) {
        throw new Error(
          `skill_run: script "${script}" is too large (${scriptBytes.length} bytes) to be a script`,
        );
      }
      if (scriptBytes.includes(0)) {
        throw new Error(
          `skill_run: script "${script}" contains binary data — scripts must be auditable text`,
        );
      }

      // 解释器三级解析（对快照字节判 shebang——与执行字节同源）
      const scriptText = scriptBytes.toString('utf-8');
      const interpreter = resolveInterpreter(scriptText, skill.interpreter, cleaned);
      if ('error' in interpreter) {
        throw new Error(`skill_run: ${skillId}/${script}: ${interpreter.error}`);
      }

      // 参数校验（argv 元素必须是字符串——类型面之外的运行时防线）
      const rawArgs = (args as { args?: unknown }).args;
      const scriptArgs: string[] = [];
      if (rawArgs !== undefined) {
        if (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== 'string')) {
          throw new Error('skill_run: "args" must be an array of strings');
        }
        scriptArgs.push(...(rawArgs as string[]));
      }

      const workspaceCwd = context?.cwd ?? process.cwd();

      // 执行副本：写临时文件后执行副本——执行的字节 = 快照（=锚定）的字节（F3）
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join: joinPath, extname } = await import('node:path');
      const execDir = mkdtempSync(joinPath(tmpdir(), 'skill-run-'));
      // 保留扩展名（.py/.sh 等映射兜底级还依赖它）
      const execPath = joinPath(execDir, `script${extname(cleaned) || '.txt'}`);
      writeFileSync(execPath, scriptBytes, { mode: 0o700 });
      const argv = [...interpreter.argv, execPath, ...scriptArgs];

      try {
        // 效应闸：kind:'runner'（包内定义脚本，非任意 shell——shellEscape 不闸它，
        // 拍板 §12.7-1；host-gate 通道仍走确认闸）
        const { gateEffect } = await import('../../execution-environment/effect-policy.js');
        const gateResult = await gateEffect(
          {
            kind: 'runner',
            command: argv.join(' '),
            cwd: workspaceCwd,
            description: `skill_run ${skillId}/${script}`,
          },
          {
            effects:
              (context as { effectChannel?: 'engine' | 'host-gate' } | undefined)?.effectChannel ??
              'engine',
            confirmEffect: (
              context as {
                confirmEffect?: Parameters<typeof gateEffect>[1]['confirmEffect'];
              } | undefined
            )?.confirmEffect,
          },
        );

        // §5.6 shell 账本同款（F8：产出落工作区进 undo/审计账本）
        const journalMode = context?.shellJournal ?? 'snapshot';
        const journalRoots = (context?.pathRoots ?? []).filter(Boolean);
        let shellBefore:
          | Awaited<
              ReturnType<
                typeof import('../../execution-environment/shell-journal.js').snapshotShellRoots
              >
            >
          | undefined;
        let notReversedPayload:
          | {
              reason: 'inventory_only' | 'budget_truncated' | 'no_roots' | 'shell_journal_off';
              created?: string[];
              modified?: string[];
              deleted?: string[];
            }
          | undefined;
        if (journalMode === 'snapshot') {
          if (journalRoots.length === 0) {
            notReversedPayload = { reason: 'no_roots' };
          } else {
            const sj = await import('../../execution-environment/shell-journal.js');
            shellBefore = await sj.snapshotShellRoots({
              roots: journalRoots,
              limit: context?.shellJournalLimit,
            });
          }
        } else {
          notReversedPayload = { reason: 'shell_journal_off' };
        }

        // ProcessSandbox 执行（jail 只读根=技能目录；写根=workspace；网络/降级沿用 effect policy）
        const { createProcessSandbox } = await import('../../execution-environment/sandbox.js');
        const sandbox = await createProcessSandbox({ forceEnvKeys: ['PATH'] });
        const requestedTimeout = Number((args as { timeout?: unknown }).timeout);
        const timeoutMs =
          Number.isFinite(requestedTimeout) && requestedTimeout > 0
            ? Math.min(Math.floor(requestedTimeout), 598_000)
            : 60_000;

        let sandboxResult;
        try {
          sandboxResult = await sandbox.executeArgv(argv, {
            cwd: workspaceCwd,
            env: { PATH: defaultPathEnv() },
            allowRoots: [workspaceCwd],
            readonlyRoots: [skillDirOf(skill)],
            networkPolicy: context?.networkPolicy ?? 'deny',
            requireJail: context?.requireJail,
            disableJail: context?.disableJail,
            homeWrite: context?.homeWrite,
            noteSecurityDegraded: context?.noteSecurityDegraded,
            signal: context?.abortSignal,
            limits: { timeoutMs, maxOutputBytes: 16 * 1024 * 1024 },
          });
        } catch (err) {
          // F19：解释器缺失的原生 ENOENT → 明确报因（不猜不降级）
          const message = err instanceof Error ? err.message : String(err);
          if (/ENOENT/.test(message)) {
            throw new Error(
              `skill_run: interpreter "${interpreter.argv[0]}" is not available on this host — ` +
                `install it or declare a different one via metadata.interpreter (${message})`,
            );
          }
          throw err;
        }

        // shell journal 同款 diff（F8：产出落工作区进 undo/审计账本；记账失败不阻断业务）
        try {
          const sj = await import('../../execution-environment/shell-journal.js');
          const effects = (
            context as {
              fileEffects?: import('@octopi-agent/core/types/tools.js').ToolFileEffects;
            } | undefined
          )?.fileEffects;
          if (shellBefore && effects) {
            const afterCap = await sj.captureShellInventory({
              roots: journalRoots,
              limit: context?.shellJournalLimit,
            });
            const diff = await sj.journalShellDiff(
              effects,
              shellBefore.capture,
              afterCap,
              shellBefore.store,
            );
            if (
              shellBefore.capture.truncated ||
              afterCap.truncated ||
              diff.notInventable.length > 0
            ) {
              await effects.noteNotReversed({
                reason: 'budget_truncated',
                created: diff.notInventable,
              });
            }
          } else if (notReversedPayload && effects) {
            await effects.noteNotReversed(notReversedPayload);
          }
        } catch {
          // 记账失败不阻断 skill_run 业务结果（与 shell 同规）
        }

        // ops 审计同款账本（F7③/F23：unreviewed/jail 如实标注；失败不阻断业务）
        try {
          context?.recordOpsEvent?.({
            event: 'ops.command.executed',
            data: {
              tool: 'skill_run',
              argv,
              cwd: workspaceCwd,
              exitCode: sandboxResult.exitCode,
              durationMs: sandboxResult.usage.elapsedMs,
              escalated: false,
              confirmed: gateResult.confirmed,
              jail: sandboxResult.isolation.backend,
              origin: `skill:${skillId}${consumed.unreviewed ? ':unreviewed' : ''}`,
              ...(gateResult.confirmSource !== undefined
                ? { confirmSource: gateResult.confirmSource }
                : {}),
              ...(gateResult.confirmedBy !== undefined
                ? { confirmedBy: gateResult.confirmedBy }
                : {}),
            },
          });
        } catch {
          // 审计失败不阻断业务（与 shell 同规）；审计可靠性由 ops 账本层兜底
        }

        return {
          skill: skillId,
          script,
          interpreter: interpreter.argv[0],
          exitCode: sandboxResult.exitCode,
          stdout: sandboxResult.stdout,
          stderr: sandboxResult.stderr,
          terminated: sandboxResult.terminated,
          ...(sandboxResult.terminateReason !== undefined
            ? { terminateReason: sandboxResult.terminateReason }
            : {}),
          unreviewed: consumed.unreviewed,
          isolation: sandboxResult.isolation,
        };
      } finally {
        // 执行副本即用即焚（内容哈希锚定不被运行时残留污染）
        rmSync(execDir, { recursive: true, force: true });
      }
    },
  };
}

/** 技能目录（jail 只读根）：从 skill.filePath 派生 */
function skillDirOf(skill: { filePath: string }): string {
  return skill.filePath.replace(/[\\/][^\\/]+$/, '');
}

/** PATH 缺省（与 shell 工具同口径；F18 单源在 platform.ts 复用） */
function defaultPathEnv(): string {
  return process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
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
