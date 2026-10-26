/**
 * 危险命令分类（§6：减速带，不是安全边界）— ops P4 pre-exec 闸 / P5 确认通道共用
 *
 * 诚实定位（必须与文档一致）：**只拦事故，不拦攻击**。shell/argv 分类必然可绕过
 * （`sh -c`、`python -c`、base64、变量拼接、别名、重定向）。任何「靠模式识别危险
 * 命令」的机制都拦不住刻意构造的注入——真正的边界是权限范围（escalation.policy /
 * L2 白名单 / OS uid）+ 审计。
 *
 * 分类表保守（§6 命中表）：命中常见破坏性模式 → 要求确认；未命中 → 放行。
 * **不做「未知即危险」**（否则误报淹没真信号）。
 *
 * 已知绕过（tests 钉死为用例，防后人误当边界）：
 * - `sh -c 'rm -rf /'` —— 嵌套 shell 的命令串本分类器不解析；
 * - `> /etc/*` 重定向 —— argv 形态根本表达不了重定向。
 */

/** 分类结论 */
export interface DangerousCommandVerdict {
  dangerous: boolean;
  /** 命中的 §6 分类表条目（审计/诊断用）；未命中为 undefined */
  pattern?: string;
}

/**
 * 剥掉提权前缀（`sudo` / `doas` 及其选项）——分类对象是真实目标命令。
 * 保守剥离：只处理选项 token 与 `-u <user>` 形态；剥不干净时宁可少报（§6 未命中放行）。
 *
 * @param argv - 完整 argv
 * @returns 剥离后的 argv（至少含一个 token）
 */
function stripPrivilegePrefix(argv: readonly string[]): readonly string[] {
  if (argv.length === 0) return argv;
  const base = basenameOf(argv[0]!);
  if (base !== 'sudo' && base !== 'doas') return argv;
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('-')) {
      // `-u user` / `--user=user` 类选项会吞掉下一个 token
      if (token === '-u' || token === '--user' || token === '-g' || token === '--group') {
        i += 1;
      }
      continue;
    }
    rest.push(...argv.slice(i));
    break;
  }
  return rest.length > 0 ? rest : argv.slice(1);
}

/** 可执行名（跨平台取末段；不解析 Windows 扩展名以外的语义） */
function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return (idx >= 0 ? normalized.slice(idx + 1) : normalized).toLowerCase();
}

/** 短选项聚合字母（`-rf` → ['r','f']）；长选项/非选项不参与 */
function shortFlagLetters(tokens: readonly string[]): Set<string> {
  const letters = new Set<string>();
  for (const token of tokens) {
    if (token === '--') break;
    if (!token.startsWith('-') || token.startsWith('--') || token === '-') continue;
    for (const ch of token.slice(1)) letters.add(ch.toLowerCase());
  }
  return letters;
}

/** 是否出现递归/强制类长选项 */
function hasLongFlag(tokens: readonly string[], names: readonly string[]): boolean {
  return tokens.some((t) => names.includes(t));
}

/**
 * 按 §6 命中表对 argv 分类。
 *
 * @param argv - 完整 argv（argv[0] = 可执行文件；提权前缀 sudo/doas 会被剥掉后分类）
 * @returns 是否危险 + 命中条目名
 */
export function classifyDangerousArgv(argv: readonly string[]): DangerousCommandVerdict {
  const effective = stripPrivilegePrefix(argv);
  if (effective.length === 0) return { dangerous: false };
  const cmd = basenameOf(effective[0]!);
  const rest = effective.slice(1);

  // `rm -rf`：递归 + 强制同现（-rf / -fr / -r -f / --recursive --force）
  if (cmd === 'rm' || cmd === 'rm.exe') {
    const flags = shortFlagLetters(rest);
    const recursive = flags.has('r') || hasLongFlag(rest, ['--recursive']);
    const force = flags.has('f') || hasLongFlag(rest, ['--force']);
    if (recursive && force) return { dangerous: true, pattern: 'rm -rf' };
    return { dangerous: false };
  }
  // `dd of=/dev/*`：直接写块设备
  if (cmd === 'dd' || cmd === 'dd.exe') {
    if (rest.some((a) => a.startsWith('of=/dev/') || a.startsWith('of=\\\\.\\'))) {
      return { dangerous: true, pattern: 'dd of=/dev/*' };
    }
    return { dangerous: false };
  }
  // `mkfs.*`：格式化
  if (cmd.startsWith('mkfs')) return { dangerous: true, pattern: 'mkfs.*' };
  // `iptables -F`：清空防火墙规则
  if (cmd === 'iptables' || cmd === 'iptables.exe' || cmd === 'nft') {
    if (rest.includes('-F') || rest.includes('--flush')) {
      return { dangerous: true, pattern: 'iptables -F' };
    }
    return { dangerous: false };
  }
  // `systemctl disable`：关服务自启
  if (cmd === 'systemctl' || cmd === 'systemctl.exe') {
    if (rest.includes('disable') || rest.includes('mask')) {
      return { dangerous: true, pattern: 'systemctl disable' };
    }
    return { dangerous: false };
  }
  // `chmod -R` / `chown -R`：递归改权限/属主
  if (cmd === 'chmod' || cmd === 'chown' || cmd === 'chmod.exe' || cmd === 'chown.exe') {
    const flags = shortFlagLetters(rest);
    if (flags.has('r') || hasLongFlag(rest, ['--recursive'])) {
      return { dangerous: true, pattern: `${cmd} -R` };
    }
    return { dangerous: false };
  }
  // `truncate`：截断文件（静默毁数据的典型手滑）
  if (cmd === 'truncate' || cmd === 'truncate.exe') {
    return { dangerous: true, pattern: 'truncate' };
  }
  return { dangerous: false };
}
