/**
 * Skill 校验器 — Agent Skills 规范校验 + 危险模式扫描（arch/skill-creation-design.md §5 静态校验）
 *
 * 两级产物：
 * - `error`：违反 spec MUST / 安全阀 → `skill_submit` 拒绝（fail-loud 逐项错误，
 *   此错误清单是规范权威——skill-creator 元技能只教心智模型，不复制规则细节）
 * - `warning`：违反 spec 推荐 / 危险模式线索 → 不拦截，进审查单供人工/LLM 审查者判断
 *
 * 不做：YAML 全量解析（frontmatter.ts 范围内）、脚本语义分析（审查环节的事）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseSkillFile, type SkillFrontmatter } from './frontmatter.js';

// ── spec 约束常量（agentskills.io specification.mdx 字段表；非部署调参） ──

/** name 最大长度（spec: Max 64 characters） */
export const SKILL_NAME_MAX = 64;
/** name 形态（spec: 小写字母数字 + 连字符；不以连字符起止、无连续连字符） */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** description 最大长度（spec: Max 1024 characters） */
export const SKILL_DESCRIPTION_MAX = 1024;
/** compatibility 最大长度（spec: Max 500 characters） */
export const SKILL_COMPATIBILITY_MAX = 500;
/** SKILL.md 行数推荐上限（spec: Keep your main SKILL.md under 500 lines） */
export const SKILL_BODY_RECOMMENDED_LINES = 500;
/** 技能目录总大小安全阀（防提交面 DoS；error） */
export const SKILL_DIR_MAX_BYTES = 8 * 1024 * 1024;

// ── 类型 ──

export type SkillIssueSeverity = 'error' | 'warning';

export interface SkillIssue {
  severity: SkillIssueSeverity;
  /** 机器可读错误码（稳定契约；CLI/工具/审查单共用） */
  code: string;
  /** 涉及字段/文件（相对技能目录） */
  field: string;
  /** 人可读说明（agent 据此修复） */
  message: string;
}

export interface SkillValidationResult {
  /** 无 error 即 ok（warning 不拦截） */
  ok: boolean;
  issues: SkillIssue[];
  /** 解析出的 frontmatter（可解析时） */
  meta?: SkillFrontmatter;
  /** SKILL.md 正文（可解析时） */
  content?: string;
}

// ── 危险模式扫描（warning：审查线索，不拦截） ──

const DANGER_PATTERNS: Array<{ code: string; re: RegExp; message: string }> = [
  {
    code: 'danger_credential_access',
    re: /(~\/\.octopi\/octopi\.json|credentials\.db|~\/\.ssh\/|\/etc\/shadow|\.env\b|api[_-]?key|secret[_-]?key)/i,
    message: 'references credential/secret locations — check for exfiltration intent',
  },
  {
    code: 'danger_exfiltration',
    re: /(curl[^\n]*(-d|--data|-F|--form|@[^\s]*)|wget[^\n]*--post|fetch\([^\n]*method:\s*['"]POST)/i,
    message: 'instructs uploading/sending data outbound — check what is sent and where',
  },
  {
    code: 'danger_pipe_to_shell',
    re: /\|\s*(ba)?sh\b|curl[^\n]*\|\s*(ba)?sh|base64\s+-d[^\n]*\|\s*(ba)?sh/i,
    message: 'pipes downloaded/decoded content into a shell',
  },
  {
    code: 'danger_destructive',
    re: /rm\s+-rf\s+(\/|~|\$HOME)\b|mkfs\.|:\(\)\s*\{.*\};:/,
    message: 'destructive filesystem command pattern',
  },
  {
    code: 'danger_dynamic_eval',
    re: /\beval\s*\(|new\s+Function\s*\(/,
    message: 'dynamic code evaluation',
  },
  {
    code: 'danger_prompt_override',
    re: /(ignore\s+(all\s+)?(previous|prior|above)\s+instructions|disregard\s+(all\s+)?(previous|prior|above)|bypass\s+(the\s+)?(safety|security|review))/i,
    message: 'prompt-override phrasing — classic prompt-injection pattern',
  },
];

function scanDangerPatterns(text: string, field: string, issues: SkillIssue[]): void {
  for (const { code, re, message } of DANGER_PATTERNS) {
    if (re.test(text)) {
      issues.push({ severity: 'warning', code, field, message });
    }
  }
}

// ── 目录收集（防 symlink 越界） ──

interface CollectedFile {
  /** 相对技能目录路径（平台分隔符） */
  rel: string;
  abs: string;
  bytes: number;
}

function collectFiles(skillDir: string, issues: SkillIssue[]): CollectedFile[] {
  const files: CollectedFile[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      issues.push({
        severity: 'error',
        code: 'dir_unreadable',
        field: relative(skillDir, dir) || '.',
        message: `cannot read directory: ${(err as Error).message}`,
      });
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(skillDir, abs);
      if (entry.isSymbolicLink()) {
        issues.push({
          severity: 'error',
          code: 'symlink_not_allowed',
          field: rel,
          message: 'symbolic links are not allowed in a skill directory (path-containment risk)',
        });
        continue;
      }
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      let bytes = 0;
      try {
        bytes = statSync(abs).size;
      } catch {
        // stat 失败交由后续读取报错；此处不重复告警
      }
      files.push({ rel, abs, bytes });
    }
  };
  walk(skillDir);
  return files;
}

// ── 主入口 ──

/**
 * 校验一个技能目录（SKILL.md + 附属文件）是否符合 Agent Skills 规范。
 *
 * @param skillDir - 技能目录绝对路径（目录名即 skill id 候选）
 * @returns 校验结果（ok = 无 error；issues 含 error/warning 全量清单）
 */
export function validateSkillDir(skillDir: string): SkillValidationResult {
  const issues: SkillIssue[] = [];
  const dirName = skillDir.split(sep).filter(Boolean).pop() ?? '';

  const files = collectFiles(skillDir, issues);
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  if (totalBytes > SKILL_DIR_MAX_BYTES) {
    issues.push({
      severity: 'error',
      code: 'dir_too_large',
      field: '.',
      message: `skill directory is ${totalBytes} bytes; max is ${SKILL_DIR_MAX_BYTES}`,
    });
  }

  const skillMd = files.find((f) => f.rel === 'SKILL.md');
  if (!skillMd) {
    issues.push({
      severity: 'error',
      code: 'skill_md_missing',
      field: 'SKILL.md',
      message: 'SKILL.md is required at the skill directory root',
    });
    return { ok: false, issues };
  }

  let raw: string;
  try {
    raw = readFileSync(skillMd.abs, 'utf-8');
  } catch (err) {
    issues.push({
      severity: 'error',
      code: 'skill_md_unreadable',
      field: 'SKILL.md',
      message: `cannot read SKILL.md: ${(err as Error).message}`,
    });
    return { ok: false, issues };
  }

  const parsed = parseSkillFile(raw);
  if (!parsed) {
    issues.push({
      severity: 'error',
      code: 'frontmatter_missing',
      field: 'SKILL.md',
      message: 'SKILL.md must start with a YAML frontmatter block (--- ... ---)',
    });
    return { ok: false, issues };
  }
  const { meta, content } = parsed;

  // 解析器不支持的 frontmatter 形态（块标量等）——fail-loud，不放行解析器认不出的输入
  for (const key of parsed.unsupported ?? []) {
    issues.push({
      severity: 'error',
      code: 'unsupported_multiline_scalar',
      field: key,
      message: `frontmatter.${key} uses a block scalar (">" / "|") which this parser does not support — write the value as a single line`,
    });
  }

  // name（spec MUST）
  const name = meta.name;
  if (!name) {
    issues.push({
      severity: 'error',
      code: 'name_missing',
      field: 'name',
      message: 'frontmatter.name is required',
    });
  } else {
    if (name.length > SKILL_NAME_MAX) {
      issues.push({
        severity: 'error',
        code: 'name_too_long',
        field: 'name',
        message: `name is ${name.length} chars; max is ${SKILL_NAME_MAX}`,
      });
    }
    if (!SKILL_NAME_RE.test(name)) {
      issues.push({
        severity: 'error',
        code: 'name_invalid',
        field: 'name',
        message:
          'name must be lowercase alphanumeric with single hyphens, not starting/ending with a hyphen',
      });
    }
    if (name !== dirName) {
      issues.push({
        severity: 'error',
        code: 'name_dir_mismatch',
        field: 'name',
        message: `name "${name}" must match the directory name "${dirName}"`,
      });
    }
  }

  // description（spec MUST）
  const description = meta.description;
  if (!description) {
    issues.push({
      severity: 'error',
      code: 'description_missing',
      field: 'description',
      message: 'frontmatter.description is required',
    });
  } else if (description.length > SKILL_DESCRIPTION_MAX) {
    issues.push({
      severity: 'error',
      code: 'description_too_long',
      field: 'description',
      message: `description is ${description.length} chars; max is ${SKILL_DESCRIPTION_MAX}`,
    });
  }

  // compatibility（spec 约束：≤500）
  if (meta.compatibility && meta.compatibility.length > SKILL_COMPATIBILITY_MAX) {
    issues.push({
      severity: 'error',
      code: 'compatibility_too_long',
      field: 'compatibility',
      message: `compatibility is ${meta.compatibility.length} chars; max is ${SKILL_COMPATIBILITY_MAX}`,
    });
  }

  // 正文（spec 推荐上限）
  const bodyLines = content.split('\n').length;
  if (bodyLines > SKILL_BODY_RECOMMENDED_LINES) {
    issues.push({
      severity: 'warning',
      code: 'body_too_long',
      field: 'SKILL.md',
      message: `body is ${bodyLines} lines; spec recommends under ${SKILL_BODY_RECOMMENDED_LINES} (move detail to references/)`,
    });
  }
  if (!content.trim()) {
    issues.push({
      severity: 'warning',
      code: 'body_empty',
      field: 'SKILL.md',
      message: 'SKILL.md body is empty — the skill would teach the agent nothing',
    });
  }

  // 危险模式扫描（正文 + 脚本文件；warning = 审查线索）
  scanDangerPatterns(content, 'SKILL.md', issues);
  for (const f of files) {
    if (f.rel === 'SKILL.md') continue;
    if (/^scripts[\\/]/.test(f.rel) && /\.(py|sh|js|mjs|ts|rb|ps1|bat|cmd)$/i.test(f.rel)) {
      try {
        scanDangerPatterns(readFileSync(f.abs, 'utf-8'), f.rel, issues);
      } catch {
        issues.push({
          severity: 'error',
          code: 'file_unreadable',
          field: f.rel,
          message: `cannot read script file: ${f.rel}`,
        });
      }
    }
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues, meta, content };
}
