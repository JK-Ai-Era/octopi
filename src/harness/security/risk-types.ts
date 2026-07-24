/**
 * Risk Assessment Types — 风险评估核心类型
 *
 * Phase 3a: Shell 命令解析 + 风险评估引擎
 * 贯穿整个安全层：解析器 → 风险评估 → 降级策略 → 安全智能体
 */

// ── Shell 命令解析结果 ──

/** 重定向信息 */
export interface Redirect {
  type: 'overwrite' | 'append' | 'input';
  target: string;
}

/** 管道/链式命令的连接方式 */
export type Connector = '|' | '&&' | '||' | ';' | '\n';

/** 解析后的单条命令段 */
export interface ParsedSegment {
  /** 命令名（第一个非重定向 token） */
  command: string;
  /** 原始参数（不含重定向） */
  args: string[];
  /** 重定向列表 */
  redirects: Redirect[];
  /** 是否通过 sudo 执行 */
  isSudo: boolean;
  /** wrapper 命令链（如 sudo -u postgres env VAR=val → ['sudo', 'env']） */
  wrappers: string[];
  /** 原始文本（解析前） */
  raw: string;
}

/** 完整的 Shell 命令解析结果 */
export interface ParsedCommand {
  /** 原始命令字符串 */
  raw: string;
  /** 拆分后的命令段 */
  segments: ParsedSegment[];
  /** 连接方式 */
  connectors: Connector[];
  /** 是否包含管道到 shell（| sh, | bash, | zsh） */
  hasShellPipe: boolean;
  /** 是否包含子 shell（$(...) 或反引号） */
  hasSubshell: boolean;
  /** 是否包含后台执行（&） */
  hasBackground: boolean;
}

// ── 风险等级 ──

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

// ── 风险因素 ──

export interface RiskFactor {
  /** 风险来源 */
  source: 'operation' | 'target' | 'method' | 'combination';
  /** 描述 */
  description: string;
  /** 贡献的风险等级 */
  level: RiskLevel;
}

// ── 安全替代方案 ──

export interface SafeAlternative {
  /** 降级描述 */
  description: string;
  /** 替代命令（可选） */
  command?: string;
  /** 替代步骤（多步降级） */
  steps?: string[];
}

// ── 风险决策 ──

export interface RiskDecision {
  /** 整体风险等级 */
  level: RiskLevel;
  /** 风险因素列表 */
  factors: RiskFactor[];
  /** 降级方案（high 风险时提供） */
  alternative?: SafeAlternative;
  /** 决策理由（人类可读） */
  reason: string;
}

// ── 路径风险分类 ──

export type PathRisk = 'safe' | 'normal' | 'sensitive' | 'protected';

// ── 工具类型分类 ──

export type ToolCategory = 'shell' | 'file' | 'http' | 'eval' | 'other';
