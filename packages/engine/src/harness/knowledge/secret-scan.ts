/**
 * 密钥/敏感形态扫描 — 外发前的门（auto-describe / embedding）
 *
 * 只做形态匹配，不做语义理解。
 */

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private_key_block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'openai_style_key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    name: 'password_assignment',
    re: /\b(?:password|passwd|pwd|api[_-]?key|secret[_-]?key)\s*[=:]\s*(?:['"][^'"]{6,}['"]|\S{6,})/i,
  },
];

function withGlobal(re: RegExp): RegExp {
  return re.flags.includes('g') ? re : new RegExp(re.source, `${re.flags}g`);
}

/**
 * 扫描文本中的密钥形态
 *
 * @returns 命中的规则名列表（空 = 未发现）
 */
export function scanSecretShapes(text: string): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) hits.push(name);
  }
  return hits;
}

export interface RedactResult {
  text: string;
  hits: string[];
}

/**
 * 脱敏：命中形态替换为 `[REDACTED:rule]`，供 embedding 外发前使用。
 *
 * @param text - 原文
 * @returns 脱敏后文本与命中规则名
 */
export function redactSecretShapes(text: string): RedactResult {
  if (!text) return { text: '', hits: [] };
  let out = text;
  const hits: string[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const g = withGlobal(re);
    if (g.test(out)) {
      hits.push(name);
      out = out.replace(g, `[REDACTED:${name}]`);
    }
  }
  return { text: out, hits };
}
