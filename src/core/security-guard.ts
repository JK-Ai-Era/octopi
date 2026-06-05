/**
 * SecurityGuard — 安全守卫（Core 内置）
 *
 * 职责：在 Agent 循环的关键节点执行强制安全检查。
 * 不可禁用、不可绕过。策略配置由 Harness 层提供。
 *
 * 检查点：
 * 1. checkUserInput — 用户消息到达时
 * 2. checkToolOutput — 工具执行后
 * 3. checkModelOutput — 模型调用后
 *
 * 设计要点：
 * - 默认实现基于模式匹配，不需要外部依赖
 * - Harness 层可以通过 SecurityPolicyConfig 调整灵敏度
 * - 检查结果包含 violations 和 sanitized 内容
 */

import type { EventBus } from './event-bus.js';
import { AgentEvents } from './event-bus.js';

// ── 类型定义 ──

/** 安全违规 */
export interface SecurityViolation {
  type: 'injection' | 'sensitive_data' | 'policy_violation';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  range?: { start: number; end: number };
}

/** 安全检查结果 */
export interface SecurityCheckResult {
  isClean: boolean;
  violations: SecurityViolation[];
  sanitized?: string;
}

/** 安全策略配置 */
export interface SecurityGuardConfig {
  /** 注入检测灵敏度 */
  injectionSensitivity?: 'low' | 'medium' | 'high';
  /** 敏感信息模式 */
  sensitivePatterns?: RegExp[];
  /** 是否启用输入检查 */
  checkInput?: boolean;
  /** 是否启用输出检查 */
  checkOutput?: boolean;
  /** 是否启用工具输出检查 */
  checkToolOutput?: boolean;
}

// ── 注入检测模式 ──

/** 常见的 prompt injection 模式 */
const INJECTION_PATTERNS = {
  low: [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /you\s+are\s+now\s+(a|an)\s+/i,
    /system\s*:\s*you\s+are/i,
  ],
  medium: [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /you\s+are\s+now\s+(a|an)\s+/i,
    /system\s*:\s*you\s+are/i,
    /forget\s+(everything|all)\s+(you|about)/i,
    /new\s+instructions?\s*:/i,
    /override\s+(your|the)\s+(system|instructions)/i,
    /disregard\s+(your|the|all)\s+(previous|prior|above)/i,
    /act\s+as\s+if\s+you\s+(are|were)/i,
    /pretend\s+you\s+(are|were|have\s+no)/i,
  ],
  high: [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /you\s+are\s+now\s+(a|an)\s+/i,
    /system\s*:\s*you\s+are/i,
    /forget\s+(everything|all)\s+(you|about)/i,
    /new\s+instructions?\s*:/i,
    /override\s+(your|the)\s+(system|instructions)/i,
    /disregard\s+(your|the|all)\s+(previous|prior|above)/i,
    /act\s+as\s+if\s+you\s+(are|were)/i,
    /pretend\s+you\s+(are|were|have\s+no)/i,
    /\[INST\]/i,
    /\[\/INST\]/i,
    /<\|im_start\|>/i,
    /<\|im_end\|>/i,
    /Human:\s*/i,
    /Assistant:\s*/i,
    /<\|system\|>/i,
    /<\|user\|>/i,
    /<\|assistant\|>/i,
    /BEGIN\s+CHAT/i,
    /END\s+CHAT/i,
  ],
} as const;

/** 默认敏感信息模式 */
const DEFAULT_SENSITIVE_PATTERNS = [
  // API keys
  /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
  // Bearer tokens
  /bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi,
  // AWS keys
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  // Private keys
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
  // Passwords in URLs
  /https?:\/\/[^:]+:[^@]+@/gi,
];

// ── 实现 ──

/**
 * SecurityGuard 实现
 *
 * 基于模式匹配的安全检查。不需要外部依赖。
 */
export class DefaultSecurityGuard {
  private config: Required<SecurityGuardConfig>;
  private eventBus: EventBus;

  constructor(eventBus: EventBus, config?: SecurityGuardConfig) {
    this.eventBus = eventBus;
    this.config = {
      injectionSensitivity: config?.injectionSensitivity ?? 'medium',
      sensitivePatterns: config?.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS,
      checkInput: config?.checkInput ?? true,
      checkOutput: config?.checkOutput ?? true,
      checkToolOutput: config?.checkToolOutput ?? true,
    };
  }

  /**
   * 检查用户输入
   */
  checkUserInput(input: string): SecurityCheckResult {
    if (!this.config.checkInput) return { isClean: true, violations: [] };
    return this.checkInjection(input, 'user_input');
  }

  /**
   * 检查工具输出
   */
  checkToolOutput(output: string): SecurityCheckResult {
    if (!this.config.checkToolOutput) return { isClean: true, violations: [] };
    return this.checkInjection(output, 'tool_output');
  }

  /**
   * 检查模型输出
   */
  checkModelOutput(output: string): SecurityCheckResult {
    if (!this.config.checkOutput) return { isClean: true, violations: [] };

    const violations: SecurityViolation[] = [];

    // 检查敏感信息泄露
    for (const pattern of this.config.sensitivePatterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(output)) !== null) {
        violations.push({
          type: 'sensitive_data',
          severity: 'high',
          description: `检测到敏感信息: ${match[0].substring(0, 30)}...`,
          range: { start: match.index, end: match.index + match[0].length },
        });
      }
    }

    if (violations.length > 0) {
      this.eventBus.emit({
        type: AgentEvents.SENSITIVE_DATA_DETECTED,
        timestamp: Date.now(),
        data: { count: violations.length },
      });
    }

    return {
      isClean: violations.length === 0,
      violations,
    };
  }

  /**
   * 检查注入
   */
  private checkInjection(content: string, source: string): SecurityCheckResult {
    const violations: SecurityViolation[] = [];
    const patterns = INJECTION_PATTERNS[this.config.injectionSensitivity];

    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      const match = regex.exec(content);
      if (match) {
        violations.push({
          type: 'injection',
          severity: this.config.injectionSensitivity === 'high' ? 'critical' : 'high',
          description: `检测到可能的 prompt injection: "${match[0].substring(0, 50)}..."`,
          range: { start: match.index, end: match.index + match[0].length },
        });
      }
    }

    if (violations.length > 0) {
      this.eventBus.emit({
        type: AgentEvents.INJECTION_DETECTED,
        timestamp: Date.now(),
        data: { source, violations },
      });
    }

    return {
      isClean: violations.length === 0,
      violations,
    };
  }
}

/** SecurityGuard 接口（供 Core 层使用） */
export interface SecurityGuard {
  checkUserInput(input: string): SecurityCheckResult;
  checkToolOutput(output: string): SecurityCheckResult;
  checkModelOutput(output: string): SecurityCheckResult;
}
