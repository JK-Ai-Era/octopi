/**
 * Degradation Strategies — 预定义安全降级策略
 *
 * 系统不尝试"理解命令目的然后生成替代方案"，
 * 而是预定义已知的降级模式。
 * 可测试、可审计、不可被 LLM 操控。
 */

import type {
  ParsedCommand,
  ParsedSegment,
  SafeAlternative,
} from './risk-types.js';
import { parseShellCommand, getRedirectTargets } from './shell-parser.js';

// ── 降级策略匹配 ──

/**
 * 尝试为高风险命令生成安全替代方案
 *
 * @returns 替代方案，如果没有匹配的降级策略则返回 null
 */
export function suggestDegradation(command: string): SafeAlternative | null {
  const parsed = parseShellCommand(command);
  if (!parsed.parsed || parsed.segments.length === 0) return null;

  // 按优先级检查降级策略
  return (
    checkCurlPipeSh(parsed) ??
    checkSafeDelete(parsed) ??
    checkSafeForcePush(parsed) ??
    checkSudoInstall(parsed) ??
    checkSafeChmod(parsed) ??
    checkSafeRedirect(parsed) ??
    null
  );
}

// ── 降级策略实现 ──

/**
 * 下载审查：curl ... | sh → 先下载到文件，展示内容
 */
function checkCurlPipeSh(parsed: ParsedCommand): SafeAlternative | null {
  if (!parsed.hasShellPipe) return null;

  // 找到 curl/wget 段
  const curlSeg = parsed.segments.find(s =>
    s.command === 'curl' || s.command === 'wget',
  );
  if (!curlSeg) return null;

  const url = curlSeg.args.find(a => a.startsWith('http'));
  if (!url) return null;

  return {
    description: `先下载脚本到临时文件，检查内容后再执行`,
    command: `${curlSeg.command} -o /tmp/downloaded_script.sh ${url}`,
    steps: [
      `1. 下载: ${curlSeg.command} -o /tmp/downloaded_script.sh ${url}`,
      '2. 检查内容: cat /tmp/downloaded_script.sh',
      '3. 确认安全后手动执行: bash /tmp/downloaded_script.sh',
    ],
  };
}

/**
 * 安全删除：rm → trash
 *
 * 只对非 safe 路径建议 trash（/tmp/ 等临时目录不需要降级）。
 * 系统路径和凭证目录不应该到这里（会被硬边界和规则引擎拦截）。
 */
function checkSafeDelete(parsed: ParsedCommand): SafeAlternative | null {
  for (const seg of parsed.segments) {
    if (seg.command !== 'rm') continue;

    const targets = seg.args.filter(a => !a.startsWith('-'));
    if (targets.length === 0) continue;

    // 只对非 safe 路径建议 trash
    // 临时目录（/tmp/）已经是 safe，不需要降级
    const nonSafeTargets = targets.filter(t => {
      const normalized = t.replace(/^~\//, process.env.HOME + '/');
      return !normalized.startsWith('/tmp/') && !normalized.startsWith('/var/tmp/');
    });

    if (nonSafeTargets.length === 0) continue;

    return {
      description: '使用 trash 替代 rm（可恢复）',
      command: `trash ${nonSafeTargets.join(' ')}`,
    };
  }

  return null;
}

/**
 * 安全 force push：--force → --force-with-lease
 */
function checkSafeForcePush(parsed: ParsedCommand): SafeAlternative | null {
  for (const seg of parsed.segments) {
    if (seg.command !== 'git') continue;

    const subcmd = seg.args[0];
    if (subcmd !== 'push') continue;
    if (!seg.args.includes('--force') && !seg.args.includes('-f')) continue;

    const newArgs = seg.args.map(a =>
      a === '--force' ? '--force-with-lease' : a === '-f' ? '--force-with-lease' : a,
    );

    return {
      description: '使用 --force-with-lease 替代 --force（防止覆盖他人提交）',
      command: `git ${newArgs.join(' ')}`,
    };
  }

  return null;
}

/**
 * 非提权安装：sudo npm install -g → 提示用 nvm 或用户级安装
 */
function checkSudoInstall(parsed: ParsedCommand): SafeAlternative | null {
  for (const seg of parsed.segments) {
    if (!seg.isSudo) continue;

    const pkgCmd = seg.wrappers.length > 0
      ? seg.command
      : null;

    if (!pkgCmd) continue;
    if (!['npm', 'yarn', 'pnpm', 'pip', 'pip3'].includes(pkgCmd)) continue;

    return {
      description: `避免提权安装 ${pkgCmd} 包`,
      steps: [
        `1. 使用 nvm/fnm 管理 Node.js 版本（不需要 sudo）`,
        `2. 或使用 --prefix 安装到用户目录`,
        `3. 或使用 ${pkgCmd}x 直接运行（不全局安装）`,
      ],
    };
  }

  return null;
}

/**
 * 安全 chmod：chmod -R 777 → 最小权限
 */
function checkSafeChmod(parsed: ParsedCommand): SafeAlternative | null {
  for (const seg of parsed.segments) {
    if (seg.command !== 'chmod') continue;

    const hasRecursive = seg.args.includes('-R') || seg.args.includes('-r');
    const mode = seg.args.find(a => !a.startsWith('-') && /^\d{3,4}$/.test(a));
    const targets = seg.args.filter(a => !a.startsWith('-') && !/^\d{3,4}$/.test(a));

    if (mode === '777' && hasRecursive) {
      return {
        description: 'chmod -R 777 会开放所有权限，建议用最小权限',
        steps: [
          `1. 目录: chmod -R 755 ${targets.join(' ')}`,
          `2. 文件: chmod -R 644 ${targets.join(' ')}`,
          `3. 或只给需要的权限: chmod -R 750 ${targets.join(' ')}`,
        ],
      };
    }
  }

  return null;
}

/**
 * 安全覆盖：> file → 先备份
 */
function checkSafeRedirect(parsed: ParsedCommand): SafeAlternative | null {
  const targets = getRedirectTargets(parsed);
  for (const target of targets) {
    // 检查是否覆盖已有文件（这里无法确定文件是否存在，只对常见路径提供建议）
    if (target.startsWith('/') && !target.startsWith('/tmp/')) {
      return {
        description: `重定向到 ${target}，建议先备份`,
        steps: [
          `1. 备份: cp ${target} ${target}.bak 2>/dev/null || true`,
          `2. 执行原命令`,
        ],
      };
    }
  }

  return null;
}
