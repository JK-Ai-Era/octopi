/**
 * Risk Evaluator — 风险评估引擎
 *
 * 基于规则的风险评估，覆盖 90%+ 的常见操作。
 * 确定性：给定相同的输入，永远产生相同的输出。
 *
 * 设计原则（避免误判）：
 * 1. 评估"操作 + 目标"的组合，不是单独评估操作
 * 2. 不确定时走 lower risk，交给 LLM 判断（emit unknown）
 * 3. 每条规则可独立测试
 * 4. 路径分类：系统路径 > 用户数据 > 项目目录 > 临时目录
 */

import type { ToolCall } from '../../core/types.js';
import type {
  ParsedCommand,
  ParsedSegment,
  RiskDecision,
  RiskFactor,
  RiskLevel,
  PathRisk,
} from './risk-types.js';
import { parseShellCommand, getRedirectTargets } from './shell-parser.js';

// ── 路径分类 ──

/** 硬保护路径（不可逆损坏） */
const PROTECTED_PATHS = [
  '/System/', '/usr/', '/bin/', '/sbin/', '/Library/',
  '/etc/',
  '/dev/',
];

/** 凭证目录 */
const CREDENTIAL_DIRS = [
  '.ssh', '.gnupg', '.aws', '.config/gcloud',
  '.openclaw', '.octopi/config',
];

/** 安全伪设备（/dev/ 下的安全目标） */
const SAFE_PSEUDO_DEVICES = new Set([
  '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom',
  '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty',
]);

/** 临时目录前缀 */
const TEMP_PREFIXES = ['/tmp/', '/var/tmp/', '/private/var/tmp/'];

/**
 * 分类目标路径的风险
 */
function classifyPath(path: string, cwd?: string): PathRisk {
  // 规范化路径
  const normalized = normalizePath(path, cwd);

  // 根路径特殊处理（精确匹配，不是 startsWith）
  if (normalized === '/') {
    return 'protected';
  }

  // 安全伪设备白名单（/dev/null 等）
  if (SAFE_PSEUDO_DEVICES.has(normalized)) {
    return 'safe';
  }

  // macOS APFS: /Users 是 firmlink → /System/Volumes/Data/Users
  // 必须在 PROTECTED_PATHS('/System/') 检查之前豁免
  if (normalized.startsWith('/System/Volumes/Data/Users/') ||
      normalized.startsWith('/System/Volumes/Data/home/')) {
    return 'normal';
  }

  // 系统保护路径
  if (PROTECTED_PATHS.some(p => normalized.startsWith(p))) {
    return 'protected';
  }

  // 凭证目录
  if (CREDENTIAL_DIRS.some(p => normalized.includes('/' + p + '/') || normalized.includes('/' + p))) {
    return 'sensitive';
  }

  // 临时目录
  if (TEMP_PREFIXES.some(p => normalized.startsWith(p))) {
    return 'safe';
  }

  // 项目目录（相对路径，或在 cwd 内）
  if (!normalized.startsWith('/') || (cwd && normalized.startsWith(cwd))) {
    return 'safe';
  }

  // 用户 home 目录
  if (normalized.startsWith('/Users/') || normalized.startsWith('/home/')) {
    return 'normal';
  }

  // 其他绝对路径
  return 'normal';
}

/**
 * 规范化路径（处理相对路径）
 */
function normalizePath(path: string, cwd?: string): string {
  // ~ 展开
  if (path === '~' || path.startsWith('~/')) {
    const home = process.env.HOME ?? '/Users/unknown';
    return path === '~' ? home : home + path.slice(1);
  }
  if (path.startsWith('/') || !cwd) {
    return path;
  }
  return cwd.endsWith('/') ? cwd + path : cwd + '/' + path;
}

// ── 操作风险分类 ──

/** 只读命令 */
const READ_ONLY_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more',
  'ls', 'dir', 'tree', 'find', 'locate',
  'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'wc', 'diff', 'file', 'stat', 'du', 'df',
  'echo', 'printf', 'date', 'whoami', 'id',
  'pwd', 'which', 'whereis', 'type',
  'env', 'printenv',
  'uname', 'hostname', 'uptime', 'ps', 'top',
  'man', 'info', 'help',
]);

/** 删除命令 */
const DELETE_COMMANDS = new Set([
  'rm', 'rmdir', 'unlink', 'shred',
]);

/** 写入命令 */
const WRITE_COMMANDS = new Set([
  'touch', 'mkdir', 'cp', 'mv', 'ln',
  'install', 'chmod', 'chown', 'chgrp',
  'tee', 'truncate',
]);

/** 网络命令 */
const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'http', 'https',
  'nc', 'ncat', 'netcat',
  'ssh', 'scp', 'rsync', 'sftp',
]);

/** 包管理命令 */
const PACKAGE_COMMANDS = new Set([
  'npm', 'yarn', 'pnpm', 'pip', 'pip3',
  'brew', 'apt', 'apt-get', 'yum', 'dnf',
  'gem', 'cargo', 'go',
]);

/** 构建/执行命令（需要关注参数） */
const BUILD_COMMANDS = new Set([
  'make', 'cmake', 'gradle', 'mvn', 'ant',
  'docker', 'podman',
]);

/** 解释器命令（内联代码执行） */
const INTERPRETER_COMMANDS = new Set([
  'python', 'python3', 'ruby', 'perl', 'node', 'php',
  'lua', 'tclsh', 'Rscript', 'scala', 'groovy',
  'bash', 'sh', 'zsh',
]);

/** 提权命令 — 通过 seg.isSudo 判断，此 Set 保留备用 */
// const PRIVILEGE_COMMANDS = new Set(['sudo', 'su']);

// ── 风险评估 ──

/**
 * 评估工具调用的风险
 *
 * @param call - 工具调用
 * @param context - 上下文信息（可选）
 * @returns 风险决策
 */
export function evaluateRisk(
  call: ToolCall,
  context?: {
    cwd?: string;
    recentToolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  },
): RiskDecision {
  // 只有 shell 工具需要深度评估
  if (!isShellTool(call.name)) {
    return evaluateNonShellTool(call);
  }

  const command = getCommandString(call);
  if (!command) {
    return { level: 'unknown', factors: [], reason: '无法提取命令字符串' };
  }

  return evaluateShellCommand(command, context?.cwd);
}

/**
 * 评估 Shell 命令的风险
 */
export function evaluateShellCommand(
  command: string,
  cwd?: string,
): RiskDecision {
  const parsed = parseShellCommand(command);
  const factors: RiskFactor[] = [];

  if (!parsed.parsed) {
    return {
      level: 'unknown',
      factors: [{ source: 'method', description: '命令解析失败', level: 'unknown' }],
      reason: '命令结构过于复杂，无法确定性解析',
    };
  }

  // 1. 检测特殊模式（管道到解释器、内联代码、子 shell）
  if (parsed.hasShellPipe) {
    factors.push({
      source: 'method',
      description: '管道到解释器（执行外部代码）',
      level: 'high',
    });
  }

  if (parsed.hasInlineCode) {
    factors.push({
      source: 'method',
      description: '内联代码执行（-c/-e 参数）',
      level: 'high',
    });
  }

  if (parsed.hasSubshell) {
    factors.push({
      source: 'method',
      description: '子 shell 执行',
      level: 'medium',
    });
  }

  // 2. 评估每个命令段
  for (const seg of parsed.segments) {
    const segRisk = evaluateSegment(seg, cwd);
    factors.push(...segRisk);
  }

  // 3. 评估重定向目标
  const redirectTargets = getRedirectTargets(parsed);
  for (const target of redirectTargets) {
    const pathRisk = classifyPath(target, cwd);
    const pathFactor = evaluatePathRisk(target, pathRisk);
    if (pathFactor) {
      factors.push(pathFactor);
    }
  }

  // 4. 评估组合风险（多个高风险命令串联）
  if (parsed.segments.length > 1) {
    const highRiskSegments = parsed.segments.filter(s => {
      return DELETE_COMMANDS.has(s.command) || s.command === 'chmod' || s.command === 'chown';
    });
    if (highRiskSegments.length > 1) {
      factors.push({
        source: 'combination',
        description: `多个高风险命令串联: ${highRiskSegments.map(s => s.command).join(', ')}`,
        level: 'high',
      });
    }
  }

  // 5. 计算整体风险等级
  const level = computeOverallRisk(factors);

  return {
    level,
    factors,
    reason: buildReason(level, factors),
  };
}

// ── 段评估 ──

function evaluateSegment(seg: ParsedSegment, cwd?: string): RiskFactor[] {
  const factors: RiskFactor[] = [];
  const cmd = seg.command;

  // 提权
  if (seg.isSudo) {
    factors.push({
      source: 'operation',
      description: `提权执行: sudo ${cmd}`,
      level: 'high',
    });
  }

  // 只读命令 → 低风险
  if (READ_ONLY_COMMANDS.has(cmd)) {
    factors.push({
      source: 'operation',
      description: `只读操作: ${cmd}`,
      level: 'low',
    });
    return factors; // 只读不需要进一步评估目标
  }

  // 删除命令
  if (DELETE_COMMANDS.has(cmd)) {
    const hasRecursive = seg.args.includes('-r') || seg.args.includes('-rf') || seg.args.includes('-R');
    const targets = seg.args.filter(a => !a.startsWith('-'));

    for (const target of targets) {
      const pathRisk = classifyPath(target, cwd);
      factors.push({
        source: 'target',
        description: `删除 ${hasRecursive ? '(递归) ' : ''}目标: ${target} (${pathRisk})`,
        level: evaluateDeleteRisk(pathRisk, hasRecursive),
      });
    }

    return factors;
  }

  // 写入命令
  if (WRITE_COMMANDS.has(cmd)) {
    if (cmd === 'chmod' || cmd === 'chown') {
      const hasRecursive = seg.args.includes('-R') || seg.args.includes('-r');
      if (hasRecursive) {
        const targets = seg.args.filter(a => !a.startsWith('-'));
        for (const target of targets) {
          const pathRisk = classifyPath(target, cwd);
          if (pathRisk === 'protected') {
            factors.push({
              source: 'target',
              description: `递归权限变更: ${target}`,
              level: 'critical',
            });
          } else if (pathRisk === 'sensitive') {
            factors.push({
              source: 'target',
              description: `递归权限变更: ${target}`,
              level: 'high',
            });
          } else {
            factors.push({
              source: 'operation',
              description: `递归权限变更: ${target}`,
              level: 'medium',
            });
          }
        }
      }
    }

    factors.push({
      source: 'operation',
      description: `写入操作: ${cmd}`,
      level: 'low',
    });
    return factors;
  }

  // 网络命令
  if (NETWORK_COMMANDS.has(cmd)) {
    if (cmd === 'curl' || cmd === 'wget') {
      // 检查是否有 POST 数据
      const hasPost = seg.args.some(a =>
        a === '-X' || a === '--request' || a === '-d' || a === '--data' || a === '--data-binary',
      );
      if (hasPost) {
        factors.push({
          source: 'operation',
          description: `网络外发: ${cmd} (POST)`,
          level: 'medium',
        });
      } else {
        factors.push({
          source: 'operation',
          description: `网络请求: ${cmd} (GET)`,
          level: 'low',
        });
      }
    } else {
      factors.push({
        source: 'operation',
        description: `网络操作: ${cmd}`,
        level: 'medium',
      });
    }
    return factors;
  }

  // 包管理命令
  if (PACKAGE_COMMANDS.has(cmd)) {
    if (seg.isSudo) {
      factors.push({
        source: 'operation',
        description: `提权包管理: sudo ${cmd}`,
        level: 'high',
      });
    } else {
      factors.push({
        source: 'operation',
        description: `包管理: ${cmd}`,
        level: 'low',
      });
    }
    return factors;
  }

  // Git 命令
  if (cmd === 'git') {
    const subcmd = seg.args[0];
    if (subcmd === 'push' && seg.args.includes('--force')) {
      factors.push({
        source: 'operation',
        description: 'Git force push（建议用 --force-with-lease）',
        level: 'medium',
      });
    } else if (subcmd === 'clean' && seg.args.includes('-f')) {
      factors.push({
        source: 'operation',
        description: 'Git clean -f（删除未跟踪文件）',
        level: 'medium',
      });
    } else {
      factors.push({
        source: 'operation',
        description: `Git 操作: git ${subcmd}`,
        level: 'low',
      });
    }
    return factors;
  }

  // 构建/容器命令（需要关注参数）
  if (BUILD_COMMANDS.has(cmd)) {
    if (cmd === 'docker' && seg.args[0] === 'run') {
      factors.push({
        source: 'operation',
        description: 'Docker run（容器执行）',
        level: 'medium',
      });
    } else {
      factors.push({
        source: 'operation',
        description: `构建/容器操作: ${cmd}`,
        level: 'low',
      });
    }
    return factors;
  }

  // 解释器命令（无 -c/-e 时视为低风险，有内联代码时由 hasInlineCode 处理）
  if (INTERPRETER_COMMANDS.has(cmd)) {
    factors.push({
      source: 'operation',
      description: `解释器执行: ${cmd}`,
      level: 'low',
    });
    return factors;
  }

  // 未知命令 → 交给 LLM
  factors.push({
    source: 'operation',
    description: `未知命令: ${cmd}`,
    level: 'unknown',
  });
  return factors;
}

// ── 路径风险评估 ──

function evaluateDeleteRisk(pathRisk: PathRisk, recursive: boolean): RiskLevel {
  switch (pathRisk) {
    case 'protected': return 'critical';
    case 'sensitive': return 'high';
    case 'safe': return 'low';
    case 'normal': return recursive ? 'medium' : 'low';
    default: return 'medium';
  }
}

function evaluatePathRisk(path: string, pathRisk: PathRisk): RiskFactor | null {
  if (pathRisk === 'safe') return null; // 安全路径不需要额外标记

  const levels: Record<PathRisk, RiskLevel> = {
    safe: 'low',
    normal: 'low',
    sensitive: 'high',
    protected: 'critical',
  };

  return {
    source: 'target',
    description: `目标路径: ${path} (${pathRisk})`,
    level: levels[pathRisk],
  };
}

// ── 非 Shell 工具评估 ──

export function evaluateNonShellTool(call: ToolCall): RiskDecision {
  // 文件工具
  if (isFileTool(call.name)) {
    const path = (call.arguments?.path ?? call.arguments?.file ?? call.arguments?.filename ?? '') as string;
    if (path) {
      const pathRisk = classifyPath(path);
      if (pathRisk === 'protected') {
        return {
          level: 'critical',
          factors: [{ source: 'target', description: `访问保护路径: ${path}`, level: 'critical' }],
          reason: `访问保护路径 ${path}，可能造成不可逆损坏`,
        };
      }
      if (pathRisk === 'sensitive') {
        return {
          level: 'high',
          factors: [{ source: 'target', description: `访问凭证目录: ${path}`, level: 'high' }],
          reason: `访问凭证目录 ${path}，可能泄露敏感信息`,
        };
      }
    }
    return { level: 'low', factors: [], reason: '文件操作，目标路径安全' };
  }

  // HTTP 工具
  if (isHttpTool(call.name)) {
    const method = ((call.arguments?.method as string) ?? 'GET').toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      return {
        level: 'medium',
        factors: [{ source: 'operation', description: `${method} 请求`, level: 'medium' }],
        reason: `${method} 请求可能发送数据`,
      };
    }
    return { level: 'low', factors: [], reason: 'GET 请求' };
  }

  // 其他工具
  return { level: 'low', factors: [], reason: '非 shell 工具' };
}

// ── 整体风险计算 ──

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
  unknown: 99,
};

function computeOverallRisk(factors: RiskFactor[]): RiskLevel {
  if (factors.length === 0) return 'low';

  let maxLevel: RiskLevel = 'low';
  let hasUnknown = false;

  for (const factor of factors) {
    if (factor.level === 'unknown') {
      hasUnknown = true;
    } else if (RISK_ORDER[factor.level] > RISK_ORDER[maxLevel]) {
      maxLevel = factor.level;
    }
  }

  // 如果有任何 unknown 因素，整体降级为 unknown
  // 原因：我们无法确定性地评估所有因素
  if (hasUnknown && maxLevel === 'low') {
    return 'unknown';
  }

  return maxLevel;
}

function buildReason(level: RiskLevel, factors: RiskFactor[]): string {
  if (factors.length === 0) return '无风险因素';

  const descriptions = factors.map(f => f.description);
  const prefix = level === 'unknown' ? '存在未知风险因素' : `风险等级: ${level}`;

  return `${prefix} — ${descriptions.join('; ')}`;
}

// ── 工具分类 ──

const SHELL_TOOLS = new Set(['shell', 'exec', 'bash', 'terminal', 'run_command', 'execute']);
const FILE_TOOLS = new Set(['file_read', 'file_write', 'file_delete', 'read_file', 'write_file', 'read', 'write', 'edit']);
const HTTP_TOOLS = new Set(['http_get', 'http_post', 'http_put', 'http_delete', 'fetch', 'web_fetch', 'curl']);

function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name);
}

function isFileTool(name: string): boolean {
  return FILE_TOOLS.has(name);
}

function isHttpTool(name: string): boolean {
  return HTTP_TOOLS.has(name);
}

function getCommandString(call: ToolCall): string | null {
  if (typeof call.arguments?.command === 'string') return call.arguments.command;
  if (typeof call.arguments?.cmd === 'string') return call.arguments.cmd;
  if (typeof call.arguments?.script === 'string') return call.arguments.script;
  return null;
}
