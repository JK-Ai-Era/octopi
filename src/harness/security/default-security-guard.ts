/**
 * DefaultSecurityGuard — 安全守卫实现（Harness 层）
 *
 * 从 Core 层迁移到 Harness 层：这是策略实现，不是机制。
 * Core 层只保留 SecurityGuard 接口和验证函数。
 *
 * 五层防护：InputGuard + OutputGuard + ToolGuard + BehaviorGuard
 * 基于模式匹配，不需要外部依赖。
 */

import type { EventBus } from '../../core/event-bus.js';
import { AgentEvents } from '../../core/event-bus.js';
import type { ToolCall } from '../../core/types/messages.js';
import type {
  SecurityViolation,
  SecurityCheckResult,
  SecurityGuard,
  SecurityGuardConfig,
  ToolCallRiskPolicy,
  BehaviorContext,
} from '../../core/interfaces/security-guard.js';

// ── 注入检测模式 ──

/** 常见的 prompt injection 模式 */
const INJECTION_PATTERNS = {
  low: [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /you\s+are\s+now\s+(a|an)\s+/i,
    /system\s*:\s*you\s+are/i,
    // 中文
    /忽略(之前|上面|全部)(的)?(指令|提示|命令|指示)/i,
    /你现在是/i,
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
    // 中文
    /忽略(之前|上面|全部|所有)(的)?(指令|提示|命令|指示|规则)/i,
    /你现在是/i,
    /忘掉(一切|所有|之前)(的)?/i,
    /新(的)?指令[：:]/i,
    /不要(管|理会|遵守)(之前|上面|原来)(的)?/i,
    /假装(你|你是|自己是)/i,
    /无视(之前|上面|所有)(的)?(指令|规则|限制)/i,
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
    /^Human:\s*/im,
    /^Assistant:\s*/im,
    /<\|system\|>/i,
    /<\|user\|>/i,
    /<\|assistant\|>/i,
    /BEGIN\s+CHAT/i,
    /END\s+CHAT/i,
    // 中文
    /忽略(之前|上面|全部|所有)(的)?(指令|提示|命令|指示|规则)/i,
    /你现在是/i,
    /忘掉(一切|所有|之前)(的)?/i,
    /新(的)?指令[：:]/i,
    /不要(管|理会|遵守)(之前|上面|原来)(的)?/i,
    /假装(你|你是|自己是)/i,
    /无视(之前|上面|所有)(的)?(指令|规则|限制)/i,
    /系统[：:]\s*你是/i,
    /BEGIN\s+CHAT/i,
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

/**
 * Shell 命令注入模式（Core 层硬边界）
 *
 * 只拦截确定性危险模式。&&、||、;、重定向等操作符
 * 本身不是危险，由 Harness 层 DefaultToolCallRiskPolicy 结构化分析。
 */
/**
 * Shell 元字符模式
 *
 * 用于检测非 shell 工具参数中的 shell 注入。
 * shell 工具的参数本身就是 shell 命令，不应拦截这些模式。
 * 非 shell 工具（web_fetch、file_read 等）参数中出现这些模式才是注入信号。
 */
const SHELL_META_PATTERNS = [
  { pattern: /\$\(/, desc: 'subshell execution \$(...)' },
  { pattern: /`[^`]+`/, desc: 'backtick subshell `...`' },
  { pattern: /\|\s*(bash|sh|zsh)/i, desc: 'pipe to shell interpreter' },
  { pattern: /;\s*(bash|sh|zsh|exec|rm|curl|wget)/i, desc: 'chained shell command' },
  { pattern: /&&\s*(bash|sh|zsh|exec|rm|curl|wget)/i, desc: 'conditional shell execution' },
  { pattern: /\$\{[^}]+\}/, desc: 'shell variable expansion ${...}' },
];

/**
 * Shell 工具真正的危险模式（极少数）
 *
 * 即使是 shell 工具，也应拦截的确定性危险操作。
 * 只包含"无论上下文都危险"的模式。
 */
const SHELL_TOOL_DANGEROUS_PATTERNS = [
  { pattern: /curl\s+[^|]*\|\s*(bash|sh|zsh)/i, desc: 'curl pipe to shell (remote code execution)' },
  { pattern: /wget\s+[^|]*\|\s*(bash|sh|zsh)/i, desc: 'wget pipe to shell (remote code execution)' },
];

/** 工具名称分类 */
const SHELL_TOOLS = new Set(['shell', 'exec', 'bash', 'terminal', 'run_command', 'execute']);
const FILE_TOOLS = new Set(['file_read', 'file_write', 'file_delete', 'read_file', 'write_file', 'read', 'write', 'edit']);
const HTTP_TOOLS = new Set(['http_get', 'http_post', 'http_put', 'http_delete', 'fetch', 'web_fetch', 'curl']);

// ── 实现 ──

/**
 * DefaultSecurityGuard — 安全守卫实现
 *
 * 五层防护：InputGuard + OutputGuard + ToolGuard + BehaviorGuard
 * 基于模式匹配，不需要外部依赖。
 */
export class DefaultSecurityGuard {
  private config: Required<SecurityGuardConfig>;
  private eventBus: EventBus;
  private registeredTools: Set<string>;
  private riskPolicy?: ToolCallRiskPolicy;

  constructor(
    eventBus: EventBus,
    config?: SecurityGuardConfig,
    registeredTools?: Set<string>,
  ) {
    this.eventBus = eventBus;
    this.registeredTools = registeredTools ?? new Set();
    this.config = {
      injectionSensitivity: config?.injectionSensitivity ?? 'medium',
      sensitivePatterns: config?.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS,
      checkInput: config?.checkInput ?? true,
      checkOutput: config?.checkOutput ?? true,
      checkToolOutput: config?.checkToolOutput ?? true,
      allowedPaths: config?.allowedPaths ?? [],
      allowShellMeta: config?.allowShellMeta ?? false,
      maxConsecutiveSameTool: config?.maxConsecutiveSameTool ?? 5,
      maxConsecutiveErrors: config?.maxConsecutiveErrors ?? 3,
      systemPrompt: config?.systemPrompt ?? '',
    };
  }

  /**
   * 设置已注册工具列表（引擎初始化后调用）
   */
  setRegisteredTools(tools: Set<string>): void {
    this.registeredTools = tools;
  }

  /**
   * 设置工具调用风险策略（由 Harness 层通过 Builder 注入）
   *
   * 注入后，checkToolCall 会用策略替代旧的正则匹配。
   * 未注入时，保持向后兼容的默认行为。
   */
  setToolCallRiskPolicy(policy: ToolCallRiskPolicy): void {
    this.riskPolicy = policy;
  }

  /**
   * 获取当前注入的风险策略（用于测试和调试）
   */
  getToolCallRiskPolicy(): ToolCallRiskPolicy | undefined {
    return this.riskPolicy;
  }

  /**
   * 设置系统提示（用于泄露检测）
   */
  setSystemPrompt(prompt: string): void {
    this.config.systemPrompt = prompt;
  }

  // ── InputGuard ──

  /**
   * 检查用户输入
   */
  checkUserInput(input: string): SecurityCheckResult {
    if (!this.config.checkInput) return { isClean: true, violations: [] };
    return this.checkInjection(input, 'user_input');
  }

  // ── OutputGuard ──

  /**
   * 检查模型输出（敏感数据 + 系统提示泄露）
   */
  checkModelOutput(output: string): SecurityCheckResult {
    if (!this.config.checkOutput) return { isClean: true, violations: [] };

    const violations: SecurityViolation[] = [];

    // 1. 检查敏感信息泄露
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

    // 2. 检查系统提示泄露
    if (this.config.systemPrompt && this.config.systemPrompt.length > 50) {
      const leakCheck = this.checkPromptLeak(output, this.config.systemPrompt);
      if (leakCheck) {
        violations.push(leakCheck);
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
   * 检查工具输出（注入检测）
   */
  checkToolOutput(output: string): SecurityCheckResult {
    if (!this.config.checkToolOutput) return { isClean: true, violations: [] };
    return this.checkInjection(output, 'tool_output');
  }

  // ── ToolGuard ──

  /**
   * 检查工具调用（命令注入 + 路径遍历 + 未授权工具）
   */
  checkToolCall(call: ToolCall): SecurityCheckResult {
    const violations: SecurityViolation[] = [];

    // 1. 工具白名单校验（硬边界，不可绕过）
    if (this.registeredTools.size > 0 && !this.registeredTools.has(call.name)) {
      violations.push({
        type: 'unauthorized_tool',
        severity: 'critical',
        description: `工具 "${call.name}" 未注册，不在允许的工具列表中`,
      });
    }

    // 2. 如果注入了风险策略，用策略替代旧的正则匹配
    if (this.riskPolicy) {
      try {
        const decision = this.riskPolicy.assess(call);

        // 映射风险等级到违规严重性
        const severityMap: Record<string, SecurityViolation['severity']> = {
          low: 'low',
          medium: 'medium',
          high: 'high',
          critical: 'critical',
        };

        if (decision.level === 'unknown') {
          // unknown → 放行，通知 Engine 调用安全智能体
          // 事件发射是通知性（审计/日志），不是触发性。
          // 触发由 riskUnknown 标记 + Engine 的 beforeToolExecution 控制。
          this.eventBus.emit({
            type: 'tool_call.risk_unknown',
            timestamp: Date.now(),
            data: { toolCall: call, decision },
          });
          // 返回 clean，让引擎继续走到 beforeToolExecution 钩子
          return { isClean: true, violations, riskUnknown: true };
        }

        if (decision.level !== 'low') {
          const severity = severityMap[decision.level] ?? 'medium';
          violations.push({
            type: 'policy_violation',
            severity,
            description: decision.reason,
          });

          this.eventBus.emit({
            type: AgentEvents.INJECTION_DETECTED,
            timestamp: Date.now(),
            data: { source: 'risk_policy', toolName: call.name, decision },
          });
        }

        return { isClean: violations.length === 0, violations };
      } catch (err) {
        // 策略失效 → 安全默认：放行，交给分布式智能体兜底
        // 事件发射是通知性（审计/日志），不是触发性。
        this.eventBus.emit({
          type: 'tool_call.risk_unknown',
          timestamp: Date.now(),
          data: { toolCall: call, error: err instanceof Error ? err.message : String(err) },
        });
        return { isClean: true, violations, riskUnknown: true };
      }
    }

    // 3. 未注入策略 → 保持向后兼容的默认行为（旧正则匹配）
    return this.checkToolCallLegacy(call, violations);
  }

  /**
   * 旧的 checkToolCall 逻辑（向后兼容）
   *
   * 当未注入 ToolCallRiskPolicy 时使用。
   * 基于正则模式匹配，覆盖命令注入、路径遍历、网络外传。
   */
  private checkToolCallLegacy(call: ToolCall, violations: SecurityViolation[]): SecurityCheckResult {
    const args = JSON.stringify(call.arguments ?? {});

    // Shell 工具：只拦截真正危险的操作（curl|bash 等远程代码执行）
    if (this.isShellTool(call.name) && !this.config.allowShellMeta) {
      for (const { pattern, desc } of SHELL_TOOL_DANGEROUS_PATTERNS) {
        if (pattern.test(args)) {
          violations.push({
            type: 'command_injection',
            severity: 'critical',
            description: `工具 "${call.name}" 参数包含危险模式: ${desc}`,
          });
          break;
        }
      }
    }

    // 非 Shell 工具：参数中出现 shell 元字符 = 注入尝试
    if (!this.isShellTool(call.name) && !this.isHttpTool(call.name)) {
      for (const { pattern, desc } of SHELL_META_PATTERNS) {
        if (pattern.test(args)) {
          violations.push({
            type: 'command_injection',
            severity: 'high',
            description: `工具 "${call.name}" 参数包含 shell 元字符（疑似注入）: ${desc}`,
          });
          break;
        }
      }
    }

    // 路径遍历检测
    if (this.isFileTool(call.name)) {
      const pathValue = call.arguments?.path ?? call.arguments?.file ?? call.arguments?.filename ?? '';
      if (typeof pathValue === 'string' && pathValue) {
        if (pathValue.includes('../') || pathValue.includes('..\\')) {
          violations.push({
            type: 'path_traversal',
            severity: 'high',
            description: `工具 "${call.name}" 参数包含目录遍历: "${pathValue}"`,
          });
        }
        if (pathValue.startsWith('/') && this.config.allowedPaths.length > 0) {
          const allowed = this.config.allowedPaths.some(p => pathValue.startsWith(p));
          if (!allowed) {
            violations.push({
              type: 'path_traversal',
              severity: 'high',
              description: `工具 "${call.name}" 访问路径 "${pathValue}" 不在允许范围内`,
            });
          }
        }
      }
    }

    // 网络外传检测
    if (this.isHttpTool(call.name)) {
      const method = (typeof call.arguments?.method === 'string' ? call.arguments.method : 'GET').toUpperCase();
      if (method === 'POST' || method === 'PUT') {
        const body = JSON.stringify(call.arguments?.body ?? call.arguments?.data ?? '');
        if (this.containsSensitivePattern(body)) {
          violations.push({
            type: 'sensitive_data',
            severity: 'critical',
            description: `工具 "${call.name}" 请求体中包含敏感数据模式（可能的数据外传）`,
          });
        }
      }
    }

    if (violations.length > 0) {
      this.eventBus.emit({
        type: AgentEvents.INJECTION_DETECTED,
        timestamp: Date.now(),
        data: { source: 'tool_call', toolName: call.name, violations },
      });
    }

    return { isClean: violations.length === 0, violations };
  }

  // ── BehaviorGuard ──

  /**
   * 检查行为异常（死循环 + 攻击模式 + 发散）
   */
  checkBehavior(ctx: BehaviorContext): SecurityCheckResult {
    const violations: SecurityViolation[] = [];

    // 1. 死循环检测
    if (ctx.consecutiveSameTool >= this.config.maxConsecutiveSameTool) {
      violations.push({
        type: 'behavior_anomaly',
        severity: ctx.consecutiveSameTool >= 10 ? 'critical' : 'high',
        description: `工具 "${ctx.lastToolName}" 连续调用 ${ctx.consecutiveSameTool} 次 — 疑似死循环`,
      });
    }

    // 2. 连续失败检测
    if (ctx.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      violations.push({
        type: 'behavior_anomaly',
        severity: 'high',
        description: `连续 ${ctx.consecutiveErrors} 次工具调用失败 — Agent 可能卡住`,
      });
    }

    // 3. 工具发散检测
    if (ctx.uniqueTools > 8 && ctx.recentToolCalls.length >= 10) {
      violations.push({
        type: 'behavior_anomaly',
        severity: 'medium',
        description: `最近 ${ctx.recentToolCalls.length} 次调用使用了 ${ctx.uniqueTools} 种不同工具 — 可能偏离任务`,
      });
    }

    // 4. 攻击模式检测
    const dangerousTools = ctx.recentToolCalls
      .filter(c => ['shell', 'exec', 'http_post', 'file_write', 'eval', 'curl'].includes(c.name))
      .map(c => c.name);
    const uniqueDangerous = new Set(dangerousTools).size;
    if (uniqueDangerous >= 3) {
      violations.push({
        type: 'behavior_anomaly',
        severity: 'critical',
        description: `短时间内调用了 ${uniqueDangerous} 种高危工具 (${[...new Set(dangerousTools)].join(', ')}) — 疑似协同攻击`,
      });
    }

    if (violations.length > 0) {
      this.eventBus.emit({
        type: AgentEvents.INJECTION_DETECTED,
        timestamp: Date.now(),
        data: { source: 'behavior', violations },
      });
    }

    return { isClean: violations.length === 0, violations };
  }

  // ── 内部方法 ──

  /** 判断是否为 shell 工具 */
  private isShellTool(name: string): boolean {
    return SHELL_TOOLS.has(name);
  }

  /** 判断是否为文件工具 */
  private isFileTool(name: string): boolean {
    return FILE_TOOLS.has(name);
  }

  /** 判断是否为 HTTP 工具 */
  private isHttpTool(name: string): boolean {
    return HTTP_TOOLS.has(name);
  }

  /** 检查内容中是否包含敏感模式 */
  private containsSensitivePattern(content: string): boolean {
    for (const pattern of this.config.sensitivePatterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      if (regex.test(content)) return true;
    }
    return false;
  }

  /** 检查系统提示泄露 */
  private checkPromptLeak(output: string, systemPrompt: string): SecurityViolation | null {
    // 如果 prompt 很短（单行或少于 100 字符），直接做子串匹配
    const lines = systemPrompt.split('\n').filter(l => l.trim().length > 20);

    let fragments: string[];
    if (lines.length < 3) {
      // 短 prompt：取前 80% 内容作为片段（去掉尾部可能的通用模板）
      const cutoff = Math.floor(systemPrompt.length * 0.8);
      fragments = [systemPrompt.substring(0, cutoff)];
    } else {
      // 长 prompt：取中间部分的连续行
      const mid = Math.floor(lines.length / 2);
      fragments = lines.slice(Math.max(0, mid - 2), mid + 3);
    }

    let matchCount = 0;
    for (const fragment of fragments) {
      if (output.includes(fragment.trim())) {
        matchCount++;
      }
    }

    // 超过一半的片段匹配，认为是泄露
    if (matchCount >= Math.ceil(fragments.length / 2)) {
      return {
        type: 'prompt_leak',
        severity: 'high',
        description: '模型输出包含系统提示的关键片段',
      };
    }

    return null;
  }

  /**
   * 检查注入（通用）
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
