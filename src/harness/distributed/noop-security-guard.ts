/**
 * Distributed Intelligence — NoopSecurityGuard
 *
 * 空实现的 SecurityGuard，用于分布式智能体。
 * 分布式智能体不需要被安全守卫保护（它本身可能就是安全守卫）。
 */

import type { SecurityGuard, SecurityCheckResult, BehaviorContext } from '../../core/security-guard.js';
import type { ToolCall } from '../../core/types.js';

/**
 * NoopSecurityGuard — 空安全守卫
 *
 * 所有检查都返回 { isClean: true, violations: [] }。
 * 用于分布式智能体的 Engine 实例，避免递归安全检查。
 */
export class NoopSecurityGuard implements SecurityGuard {
  checkUserInput(_input: string): SecurityCheckResult {
    return { isClean: true, violations: [] };
  }

  checkModelOutput(_output: string): SecurityCheckResult {
    return { isClean: true, violations: [] };
  }

  checkToolOutput(_output: string): SecurityCheckResult {
    return { isClean: true, violations: [] };
  }

  checkToolCall(_call: ToolCall): SecurityCheckResult {
    return { isClean: true, violations: [] };
  }

  checkBehavior(_ctx: BehaviorContext): SecurityCheckResult {
    return { isClean: true, violations: [] };
  }
}
