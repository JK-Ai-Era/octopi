/**
 * ApprovalManager — 审批管理器
 *
 * 管理审批请求的生命周期：创建 → 等待决策 → 应用结果。
 * 支持决策缓存（session 级 / 永久）。
 */

import { randomUUID } from 'node:crypto';
import type { ToolCall } from '../../core/types/messages.js';
import type {
  ApprovalRequest,
  ApprovalDecision,
  ApprovalProvider,
  ApprovalPolicy,
  ApprovalLevel,
} from '../../core/interfaces/human-in-the-loop.js';

/** ApprovalManager 配置 */
export interface ApprovalManagerConfig {
  /** 全局审批级别 */
  level: ApprovalLevel;
  /** 请求超时（毫秒，默认 60s） */
  timeoutMs?: number;
  /** 审批提供者（TUI/Gateway 实现） */
  provider?: ApprovalProvider;
}

/** 缓存的决策 */
interface CachedDecision {
  toolName: string;
  decision: 'approve' | 'deny';
  scope: 'session' | 'permanent';
  expiresAt: number;
}

export class ApprovalManager {
  private config: ApprovalManagerConfig;
  private decisionCache = new Map<string, CachedDecision>();

  constructor(config: ApprovalManagerConfig) {
    this.config = config;
  }

  /**
   * 判断是否需要审批，需要时请求审批
   *
   * @returns true 表示放行，false 表示拒绝
   */
  async check(toolCall: ToolCall, riskLevel: string, riskDescription: string): Promise<boolean> {
    // 1. 检查缓存
    const cached = this.getCachedDecision(toolCall);
    if (cached) return cached === 'approve';

    // 2. 检查级别是否需要审批
    if (!this.needsApproval(riskLevel)) return true;

    // 3. 如果没有 provider（非交互环境），根据级别决定
    if (!this.config.provider || !this.config.provider.isInteractive()) {
      // 非交互环境：auto 级别放行，其他拒绝
      return this.config.level === 'auto';
    }

    // 4. 请求审批
    const request: ApprovalRequest = {
      id: randomUUID().slice(0, 8),
      toolCall,
      riskLevel: riskLevel as ApprovalRequest['riskLevel'],
      riskDescription,
      actionDescription: `${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`,
      createdAt: Date.now(),
      timeoutMs: this.config.timeoutMs ?? 60_000,
    };

    const decision = await this.config.provider.requestApproval(request);

    // 5. 缓存决策
    if (decision.decision === 'approve_always') {
      this.decisionCache.set(toolCall.name, {
        toolName: toolCall.name,
        decision: 'approve',
        scope: 'permanent',
        expiresAt: Infinity,
      });
    } else if (decision.decision === 'approve_session') {
      this.decisionCache.set(toolCall.name, {
        toolName: toolCall.name,
        decision: 'approve',
        scope: 'session',
        expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24h
      });
    }

    return decision.decision === 'approve' || decision.decision === 'approve_always' || decision.decision === 'approve_session';
  }

  private needsApproval(riskLevel: string): boolean {
    switch (this.config.level) {
      case 'auto': return false;
      case 'confirm_all': return true;
      case 'confirm_high_risk': return riskLevel === 'high' || riskLevel === 'critical' || riskLevel === 'unknown';
      default: return false;
    }
  }

  private getCachedDecision(toolCall: ToolCall): 'approve' | 'deny' | null {
    const cached = this.decisionCache.get(toolCall.name);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
      this.decisionCache.delete(toolCall.name);
      return null;
    }
    return cached.decision;
  }
}

/** 创建默认审批策略 */
export function createApprovalPolicy(level: ApprovalLevel): ApprovalPolicy {
  return {
    requiresApproval(_toolCall: ToolCall, riskLevel: string): boolean {
      switch (level) {
        case 'auto': return false;
        case 'confirm_all': return true;
        case 'confirm_high_risk': return riskLevel === 'high' || riskLevel === 'critical' || riskLevel === 'unknown';
        default: return false;
      }
    },
  };
}
