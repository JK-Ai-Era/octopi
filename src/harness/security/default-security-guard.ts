/**
 * DefaultSecurityGuard — 安全守卫实现（Harness 层）
 *
 * 从 Core 层迁移到 Harness 层：这是策略实现，不是机制。
 * Core 层只保留 SecurityGuard 接口和验证函数。
 *
 * 分层（安全不可绕过）：
 * 1. **硬边界** — 只拦完全确定有害的操作，永远执行，不受 `enforce` 影响
 * 2. **ToolCallRiskPolicy** — 永远接线；模糊/有争议操作由风险策略分档
 * 3. **Input/Output** — prompt injection 与敏感信息检查始终开启
 *
 * 不对不透明载荷（file_write.content 等）做 shell 元字符扫描：
 * `fs.writeFile` 不解释 `` ` `` / `$()` / `${}`，Markdown 代码与文档示例是合法内容。
 */

import { isAbsolute } from 'node:path';

import type { EventBus } from '../../core/primitives/event-bus.js';
import { AgentEvents } from '../events/agent-event-map.js';
import { getRunScope } from '../run-scope.js';
import type { ToolCall } from '../../core/types/messages.js';
import type {
  SecurityViolation,
  SecurityCheckResult,
  SecurityGuard,
  SecurityGuardConfig,
  ToolCallRiskPolicy,
  BehaviorContext,
} from '../../core/interfaces/security-guard.js';
import { DefaultToolCallRiskPolicy } from './default-risk-policy.js';
import {
  detectCatastrophicRecursiveDelete,
  detectDownloadToInterpreter,
  detectDiskWipe,
  isProtectedPath,
} from './risk-evaluator.js';

/**
 * 路径是否位于 base 之下（段边界，拒绝 project 绕过 project-evil）
 */
function isPathUnderBase(pathValue: string, base: string): boolean {
  const isWin = pathValue.includes('\\') || base.includes('\\') || /^[A-Za-z]:/.test(pathValue) || /^[A-Za-z]:/.test(base);
  if (isWin) {
    const p = pathValue.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
    const b = base.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
    return p === b || p.startsWith(b + '\\');
  }
  const p = pathValue.replace(/\/+$/, '');
  const b = base.replace(/\/+$/, '');
  return p === b || p.startsWith(b + '/');
}

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
 * 硬边界 — 字符串级模式（下载执行 / 反弹 shell / PS 摇篮）
 *
 * 下载→解释器、清盘、灾难删由 risk-evaluator 结构化探测（命令位判定）。
 * 不扫 content 载荷；不把子 shell / 变量展开当硬拦。
 */
const SHELL_TOOL_DANGEROUS_PATTERNS = [
  // PowerShell 下载执行摇篮（含 irm / | iex / System.Net.WebClient）
  {
    pattern: /\b(?:iex|invoke-expression)\b[\s\S]{0,120}\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|new-object\s+(?:system\.)?net\.webclient|\[net\.webclient\])/i,
    desc: 'PowerShell IEX download cradle (remote code execution)',
  },
  {
    pattern: /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[\s\S]{0,80}\|\s*(?:iex|invoke-expression)\b/i,
    desc: 'PowerShell download | iex cradle (remote code execution)',
  },
  {
    pattern: /(?:system\.)?net\.webclient[\s\S]{0,80}\.downloadstring\s*\(/i,
    desc: 'PowerShell WebClient.DownloadString cradle (remote code execution)',
  },
  {
    pattern: /\[net\.webclient\]::new\s*\(/i,
    desc: 'PowerShell [Net.WebClient]::new cradle (remote code execution)',
  },
  // 反弹 shell
  {
    pattern: /\/dev\/tcp\/(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9][a-z0-9.-]*)\/\d+/i,
    desc: 'reverse shell via /dev/tcp (remote control)',
  },
  {
    pattern: /\b(?:nc|ncat|netcat)\b[^|;&]*\s(?:-e|-c|--exec)\s+(?:\/bin\/)?(?:ba|z|k|da|a)?sh\b/i,
    desc: 'reverse shell via nc -e/-c/--exec (remote control)',
  },
  {
    pattern: /\b(?:nc|ncat|netcat)\b[^|;&]*\s(?:-e|-c|--exec)\s+cmd(?:\.exe)?\b/i,
    desc: 'reverse shell via nc -e cmd (remote control)',
  },
];

/** 工具名称分类 */
const SHELL_TOOLS = new Set(['shell', 'exec', 'bash', 'terminal', 'run_command', 'execute']);
/** 写类文件工具（路径遍历/保护路径检查） */
const FILE_WRITE_TOOLS = new Set([
  'file_write', 'file_edit', 'file_delete', 'delete_file',
  'write_file', 'write', 'edit',
]);
/** 删类文件工具（保护路径硬边界） */
const FILE_DELETE_TOOLS = new Set([
  'file_delete', 'delete_file',
]);
/** 读类文件工具 */
const FILE_READ_TOOLS = new Set([
  'file_read', 'file_list', 'file_search',
  'read_file', 'read',
]);
const FILE_TOOLS = new Set([...FILE_WRITE_TOOLS, ...FILE_READ_TOOLS]);

// ── 实现 ──

/**
 * DefaultSecurityGuard — 安全守卫实现
 *
 * 硬边界 + 始终接线的 ToolCallRiskPolicy；Input/Output 检查不可关闭。
 */
export class DefaultSecurityGuard {
  private config: Required<SecurityGuardConfig>;
  private eventBus: EventBus;
  private registeredTools: Set<string>;
  private riskPolicy: ToolCallRiskPolicy;

  constructor(
    eventBus: EventBus,
    config?: SecurityGuardConfig,
    registeredTools?: Set<string>,
  ) {
    this.eventBus = eventBus;
    this.registeredTools = registeredTools ?? new Set();
    this.config = {
      enforce: config?.enforce ?? 'block',
      injectionSensitivity: config?.injectionSensitivity ?? 'medium',
      sensitivePatterns: config?.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS,
      allowedPaths: config?.allowedPaths ?? [],
      systemPrompt: config?.systemPrompt ?? '',
    };
    // 风险策略永远接线；Builder 可再注入带 cwd 的实例
    this.riskPolicy = new DefaultToolCallRiskPolicy();
  }

  /**
   * 设置已注册工具列表（引擎初始化后调用）
   */
  setRegisteredTools(tools: Set<string>): void {
    this.registeredTools = tools;
  }

  /**
   * 覆盖工具调用风险策略（Builder 注入带 workspace cwd 的实例）
   */
  setToolCallRiskPolicy(policy: ToolCallRiskPolicy): void {
    this.riskPolicy = policy;
  }

  /**
   * 获取当前注入的风险策略（用于测试和调试）
   */
  getToolCallRiskPolicy(): ToolCallRiskPolicy {
    return this.riskPolicy;
  }

  /**
   * 发射安全事件并附带 Run 身份（Observer/security 通道按 session 归属）
   */
  private emitRunEvent(event: {
    type: string;
    timestamp?: number;
    agentId?: string;
    sessionId?: string;
    data?: Record<string, unknown>;
  }): void {
    const scope = getRunScope();
    const sessionId = event.sessionId ?? scope?.sessionId;
    const agentId = event.agentId ?? scope?.agentId;
    this.eventBus.emit({
      type: event.type,
      timestamp: event.timestamp ?? Date.now(),
      agentId,
      sessionId,
      data: {
        ...(event.data ?? {}),
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {}),
      },
    });
  }

  /**
   * 设置系统提示（用于泄露检测）
   */
  setSystemPrompt(prompt: string): void {
    this.config.systemPrompt = prompt;
  }

  // ── InputGuard ──

  /**
   * 检查用户输入（始终开启）
   */
  checkUserInput(input: string): SecurityCheckResult {
    return this.checkInjection(input, 'user_input');
  }

  // ── OutputGuard ──

  /**
   * 检查模型输出（敏感数据 + 系统提示泄露，始终开启）
   */
  checkModelOutput(output: string): SecurityCheckResult {
    const violations: SecurityViolation[] = [];

    // 1. 检查敏感信息泄露
    for (const pattern of this.config.sensitivePatterns) {
      // 强制 g，避免自定义无 g 正则导致 lastIndex 不推进而死循环
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      const regex = new RegExp(pattern.source, flags);
      let match;
      while ((match = regex.exec(output)) !== null) {
        if (match[0] === '') {
          regex.lastIndex++;
          continue;
        }
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
      this.emitRunEvent({
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
   * 检查工具输出（注入检测，始终开启）
   */
  checkToolOutput(output: string): SecurityCheckResult {
    return this.checkInjection(output, 'tool_output');
  }

  // ── ToolGuard ──

  /**
   * 检查工具调用
   *
   * 1. 硬边界：未注册工具、路径遍历、allowedPaths 越界、下载执行/摇篮/反弹 shell/清盘、递归删根·保护路径
   * 2. ToolCallRiskPolicy：其余风险分档（永远接线）
   */
  checkToolCall(call: ToolCall): SecurityCheckResult {
    const hardViolations = this.checkHardBoundaries(call);
    return this.assessWithRiskPolicy(call, hardViolations);
  }

  /**
   * 硬边界 — 只拦完全确定有害的操作
   *
   * 不受 `enforce: audit` 影响；不对 content 等载荷做元字符匹配。
   */
  private checkHardBoundaries(call: ToolCall): SecurityViolation[] {
    const violations: SecurityViolation[] = [];

    // 1. 工具白名单校验（硬边界，不可绕过）
    if (this.registeredTools.size > 0 && !this.registeredTools.has(call.name)) {
      violations.push({
        type: 'unauthorized_tool',
        severity: 'critical',
        description: `工具 "${call.name}" 未注册，不在允许的工具列表中`,
      });
    }

    // 2. Shell 工具：远程代码执行 + 递归删根/保护路径 + 清盘
    if (this.isShellTool(call.name)) {
      const command = this.getCommandString(call);
      if (command) {
        for (const { pattern, desc } of SHELL_TOOL_DANGEROUS_PATTERNS) {
          if (pattern.test(command)) {
            violations.push({
              type: 'command_injection',
              severity: 'critical',
              description: `工具 "${call.name}" 参数包含危险模式: ${desc}`,
            });
            break;
          }
        }
        const downloadExec = detectDownloadToInterpreter(command);
        if (downloadExec) {
          violations.push({
            type: 'command_injection',
            severity: 'critical',
            description: `工具 "${call.name}" ${downloadExec}`,
          });
        }
        const wipe = detectDiskWipe(command);
        if (wipe) {
          violations.push({
            type: 'destructive_operation',
            severity: 'critical',
            description: `工具 "${call.name}" ${wipe}`,
          });
        }
        const catastrophic = detectCatastrophicRecursiveDelete(command);
        if (catastrophic) {
          violations.push({
            type: 'destructive_operation',
            severity: 'critical',
            description: `工具 "${call.name}" ${catastrophic}`,
          });
        }
      }
    }

    // 3. 文件工具路径：遍历 + allowedPaths 越界 + 删保护路径（不扫 content）
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
        if (isAbsolute(pathValue) && this.config.allowedPaths.length > 0) {
          const allowed = this.config.allowedPaths.some(p => isPathUnderBase(pathValue, p));
          if (!allowed) {
            violations.push({
              type: 'path_traversal',
              severity: 'high',
              description: `工具 "${call.name}" 访问路径 "${pathValue}" 不在允许范围内`,
            });
          }
        }
        // 删除根 / 系统保护路径 = 确定灾难（file_write 到保护路径仍归 RiskPolicy）
        if (FILE_DELETE_TOOLS.has(call.name) && isProtectedPath(pathValue)) {
          violations.push({
            type: 'destructive_operation',
            severity: 'critical',
            description: `工具 "${call.name}" 删除保护路径: "${pathValue}"`,
          });
        }
      }
    }

    return violations;
  }

  /**
   * 风险策略评估（永远执行）
   *
   * - low → 放行
   * - unknown → riskUnknown（交给安全智能体）
   * - medium+ → 记 violation；`enforce: audit` 时降为 medium（只告警不拦），硬边界不受影响
   */
  private assessWithRiskPolicy(
    call: ToolCall,
    hardViolations: SecurityViolation[],
  ): SecurityCheckResult {
    let decision;
    try {
      decision = this.riskPolicy.assess(call);
    } catch (err) {
      // 策略异常：只读 fail-open（交下游），写类 fail-closed（至少 medium 不直接放行写）
      this.emitRunEvent({
        type: 'tool_call.risk_unknown',
        timestamp: Date.now(),
        data: { toolCall: call, error: err instanceof Error ? err.message : String(err) },
      });
      const isWriteCall = FILE_WRITE_TOOLS.has(call.name) || this.isShellTool(call.name);
      const violations = [...hardViolations];
      if (isWriteCall) {
        violations.push({
          type: 'policy_violation',
          severity: 'medium',
          description: 'RiskPolicy 不可用，写类调用保守告警（enforce=block 时 medium 不拦写，由 unknown 路径升级）',
        });
      }
      return { isClean: violations.length === 0, violations, riskUnknown: true };
    }

    if (decision.level === 'unknown') {
      this.emitRunEvent({
        type: 'tool_call.risk_unknown',
        timestamp: Date.now(),
        data: { toolCall: call, decision },
      });
      return { isClean: hardViolations.length === 0, violations: hardViolations, riskUnknown: true };
    }

    const riskViolations: SecurityViolation[] = [];
    if (decision.level !== 'low') {
      const severityMap: Record<string, SecurityViolation['severity']> = {
        low: 'low',
        medium: 'medium',
        high: 'high',
        critical: 'critical',
      };
      let severity = severityMap[decision.level] ?? 'medium';
      // audit：风险发现只告警；硬边界 severity 原样保留
      if (this.config.enforce === 'audit' && (severity === 'high' || severity === 'critical')) {
        severity = 'medium';
      }
      riskViolations.push({
        type: 'policy_violation',
        severity,
        description: decision.reason,
      });

      this.emitRunEvent({
        type: AgentEvents.INJECTION_DETECTED,
        timestamp: Date.now(),
        data: { source: 'risk_policy', toolName: call.name, decision },
      });
    }

    const violations = [...hardViolations, ...riskViolations];
    if (hardViolations.length > 0) {
      this.emitRunEvent({
        type: AgentEvents.INJECTION_DETECTED,
        timestamp: Date.now(),
        data: { source: 'hard_boundary', toolName: call.name, violations: hardViolations },
      });
    }

    return { isClean: violations.length === 0, violations };
  }

  // ── BehaviorGuard ──

  /**
   * 检查行为异常
   *
   * 边界（arch/run-guard-refactor.md P1.3）：
   * - 「跑飞」（连续同工具 / 连续错误）归 **RunGuard**，本方法不再重复裁决；
   *   保留的 loop/error 规则仅作 API 兼容，默认视为 deprecated，主路径不调用。
   * - Security 只保留**恶意/协同攻击**形态（高危工具组合等）。
   *
   * 主路径当前不调用 checkBehavior；run 飞检测走 reliability + RunGuard 检查点。
   */
  checkBehavior(ctx: BehaviorContext): SecurityCheckResult {
    const violations: SecurityViolation[] = [];

    // 1-2. 死循环 / 连续失败 — **已上收 RunGuard**（failureKind loop/blowup）
    // 保留字段兼容，不在此产生 security 裁决，避免与 Guard 双闸。
    // 若外部仍依赖 checkBehavior 发现 loop，应改为消费 RunGuard verdict / loop 事件。

    // 3. 工具发散 — 归 RunGuard thrash；此处不再报 security violation

    // 4. 攻击模式检测（Security 保留）
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
      this.emitRunEvent({
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

  /** 提取可能作为命令执行的字段（仅 shell 工具硬边界用） */
  private getCommandString(call: ToolCall): string | null {
    if (typeof call.arguments?.command === 'string') return call.arguments.command;
    if (typeof call.arguments?.cmd === 'string') return call.arguments.cmd;
    if (typeof call.arguments?.script === 'string') return call.arguments.script;
    return null;
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
      this.emitRunEvent({
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
