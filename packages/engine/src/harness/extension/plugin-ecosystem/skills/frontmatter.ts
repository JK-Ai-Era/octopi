/**
 * SKILL.md frontmatter 解析 — Agent Skills 标准字段（agentskills.io spec）
 *
 * 单一真相源：DefaultSkillManager 的发现/加载与 validate.ts 的校验
 * 共用本解析（E8 one source of truth）——不允许第二份 frontmatter 解析。
 *
 * 标准字段：name / description / license / compatibility / metadata / allowed-tools
 * octopi 扩展（顶层旧字段继续兼容解析，新写入走 metadata）：
 * - `command`（斜杠命令注册）→ metadata.command 亦认
 * - `disable-model-invocation` → metadata.disable-model-invocation 亦认
 * - `tools`（逗号分隔，旧字段）→ 等价 `allowed-tools`（空格分隔）
 *
 * 解析范围：标量行 + 单层嵌套 map（metadata 用）。多行块/锚点等完整 YAML
 * 不在范围——解析失败的行不报错跳过（校验器负责判缺失，解析器不判合法性）。
 */

/** SKILL.md frontmatter 归一化输出 */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  /** metadata（标准：string→string map；单层嵌套解析） */
  metadata?: Record<string, string>;
  /** 归一工具白名单（`allowed-tools` 空格分隔，兼容旧 `tools` 逗号分隔） */
  allowedTools?: string[];
  /** 兼容旧顶层 `disable-model-invocation` / metadata 同名键 */
  disableModelInvocation?: boolean;
  /** 斜杠命令名（顶层 `command` / metadata.command；已规范化，非法不透出） */
  command?: string;
  /** 其余顶层标量键透传（key: value 原文，已去引号） */
  [key: string]: string | boolean | string[] | Record<string, string> | undefined;
}

/** 解析结果：frontmatter + 正文（不含 frontmatter 分隔块） */
export interface ParsedSkillFile {
  meta: SkillFrontmatter;
  content: string;
  /**
   * 解析器不支持的 frontmatter 形态（块标量 `>`/`|` 等）的键名。
   * validate 据此报 error（fail-loud）：解析器不认的输入不得静默通过校验。
   */
  unsupported?: string[];
}

/**
 * 剥离 YAML 标量的成对引号（双引号含转义还原；单引号按 YAML 惯例还原 ''）。
 * 只处理标量层的一对引号——多行/嵌套 YAML 仍不在解析范围。
 *
 * @param value - YAML 标量原文
 * @returns 去引号后的值
 */
export function unquoteYamlScalar(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * 规范化 command 名（不含 `/`，小写）；非法返回 undefined。
 * 校验 `^[a-z][a-z0-9_-]*$`（可写 `/pdf`，规范化后存储）。
 *
 * @param raw - frontmatter 原文值
 * @returns 规范化命令名；非法时 undefined
 */
export function normalizeSkillCommand(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim().replace(/^\/+/, '').toLowerCase();
  return trimmed && /^[a-z][a-z0-9_-]*$/.test(trimmed) ? trimmed : undefined;
}

/**
 * 解析 SKILL.md 全文（frontmatter + 正文）。
 *
 * frontmatter 以 `---` 行首尾包裹；内部解析：
 * - 标量行 `key: value`（值做引号剥离）
 * - 单层嵌套 map（缩进行 `  key: value` 归入最近的无值父键，`metadata` 语义）
 *
 * @param raw - SKILL.md 文件原文（CRLF 已在此归一）
 * @returns 解析结果；无 frontmatter 块时返回 null
 */
export function parseSkillFile(raw: string): ParsedSkillFile | null {
  const normalized = raw.replace(/\r\n/g, '\n');
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return null;

  const fmLines = fmMatch[1].split('\n');
  const content = fmMatch[2].trim();

  const scalars: Record<string, string> = {};
  let nestedParent: string | undefined;
  const nested: Record<string, Record<string, string>> = {};
  const unsupported: string[] = [];

  for (const line of fmLines) {
    const nestedMatch = line.match(/^ {2,}([\w-]+):\s*(.*)$/);
    if (nestedMatch && nestedParent) {
      nested[nestedParent][nestedMatch[1]] = unquoteYamlScalar(nestedMatch[2].trim());
      continue;
    }
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (value === '') {
      nestedParent = key;
      nested[key] = {};
      continue;
    }
    // 块标量（description: > / | 等）：正文是随后的缩进行——本解析器不支持，
    // 记入 unsupported（validate 报 error），绝不把 '>' 当值收下（静默劣化索引）
    if (/^[>|][+-]?$/.test(value)) {
      unsupported.push(key);
      continue;
    }
    nestedParent = undefined;
    scalars[key] = unquoteYamlScalar(value);
  }

  const meta: SkillFrontmatter = {};
  for (const [key, value] of Object.entries(scalars)) {
    meta[key] = value;
  }
  for (const [key, value] of Object.entries(nested)) {
    if (Object.keys(value).length > 0) meta[key] = value;
  }

  // 归一：allowed-tools（标准，空格分隔）与 tools（旧字段，逗号分隔）取并集语义
  const allowed: string[] = [];
  const specTools = scalars['allowed-tools'];
  if (specTools) allowed.push(...specTools.split(/\s+/).map((s) => s.trim()).filter(Boolean));
  const legacyTools = scalars.tools;
  if (legacyTools) {
    allowed.push(...legacyTools.split(/[,，]/).map((s) => s.trim()).filter(Boolean));
  }
  if (allowed.length > 0) meta.allowedTools = [...new Set(allowed)];
  delete meta.tools;
  delete meta['allowed-tools'];

  const disableRaw = scalars['disable-model-invocation'] ?? nested.metadata?.['disable-model-invocation'];
  if (disableRaw !== undefined) {
    meta.disableModelInvocation = disableRaw === 'true';
    delete meta['disable-model-invocation'];
  }

  const commandRaw = scalars.command ?? nested.metadata?.command;
  const command = normalizeSkillCommand(commandRaw);
  if (command) meta.command = command;
  else delete meta.command;

  // name/description 必须是标量字符串：嵌套块（description:\n  key: v）会赋成 map，
  // 下游 formatForPrompt 的 xmlEscape(str.replace) 会 TypeError 打爆装配——不合格即删
  //（discover 跳过 / validate 报缺失，fail-loud 优于带病通过）
  if (typeof meta.name !== 'string') delete meta.name;
  if (typeof meta.description !== 'string') delete meta.description;

  return { meta, content, ...(unsupported.length > 0 ? { unsupported } : {}) };
}
