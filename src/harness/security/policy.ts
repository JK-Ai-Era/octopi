/**
 * SecurityPolicy — 安全策略配置
 *
 * Harness 层组件。配置 SecurityGuard 的行为参数。
 * 通过 AgentBuilder 注入。
 */

import type { SecurityGuardConfig } from '../../core/security-guard.js';

/** 安全策略预设 */
export const SecurityPresets = {
  /** 开发环境 — 宽松 */
  development: {
    injectionSensitivity: 'low' as const,
    checkInput: true,
    checkOutput: false,
    checkToolOutput: false,
  },

  /** 测试环境 — 中等 */
  testing: {
    injectionSensitivity: 'medium' as const,
    checkInput: true,
    checkOutput: false,
    checkToolOutput: true,
  },

  /** 生产环境 — 严格 */
  production: {
    injectionSensitivity: 'high' as const,
    checkInput: true,
    checkOutput: true,
    checkToolOutput: true,
  },

  /** 最大安全 — 全部检查 */
  maximum: {
    injectionSensitivity: 'high' as const,
    checkInput: true,
    checkOutput: true,
    checkToolOutput: true,
    sensitivePatterns: [
      /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
      /bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi,
      /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
      /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
      /https?:\/\/[^:]+:[^@]+@/gi,
      /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,  // 电话号码
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,  // 邮箱
      /\b\d{15,19}\b/g,  // 信用卡号
    ],
  },
} satisfies Record<string, SecurityGuardConfig>;

/** 环境类型 */
export type Environment = keyof typeof SecurityPresets;

/**
 * 根据环境获取安全策略
 */
export function getSecurityPolicy(env: Environment): SecurityGuardConfig {
  return SecurityPresets[env];
}
