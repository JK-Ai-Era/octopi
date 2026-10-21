/**
 * CLI 参数解析
 */

export interface CliArgs {
  command: string;
  subcommand?: string;
  config?: string;
  port?: number;
  help?: boolean;
  verbose?: boolean;
  fix?: boolean;
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
  only?: string[];
  allowDeleteLegacyDirs?: boolean;
  /** doctor --restore [backupPath]；true = 最新备份 */
  restore?: boolean | string;
  /** llm-diff：目标 session id（缺省 = 最近更新的 session） */
  session?: string;
  /** llm-diff：wire dump 根目录 */
  dir?: string;
  /** llm-diff：展示的调用条数（0 = 全部） */
  limit?: number;
}

/**
 * 读取 flag 的取值：缺值（或紧跟另一个 flag）时直接报错
 *
 * 这三个 flag 的值决定「看哪份数据」，猜错比报错更危险，因此不做静默回退。
 *
 * @param argv - 参数表
 * @param index - 取值位置
 * @param flag - flag 名（用于错误信息）
 * @returns 取值
 */
function requireFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value == null || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  let help = false;
  let verbose = false;
  let config: string | undefined;
  let port: number | undefined;
  let fix = false;
  let dryRun = false;
  let json = false;
  let yes = false;
  let allowDeleteLegacyDirs = false;
  let only: string[] | undefined;
  let restore: boolean | string | undefined;
  let session: string | undefined;
  let dir: string | undefined;
  let limit: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--config':
      case '-c':
        config = argv[++i];
        break;
      case '--port':
      case '-p':
        port = parseInt(argv[++i]!, 10);
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      case '--verbose':
      case '-v':
        verbose = true;
        break;
      case '--fix':
        fix = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--json':
        json = true;
        break;
      case '--yes':
      case '-y':
        yes = true;
        break;
      case '--only': {
        const rawOnly = argv[++i] ?? '';
        only = rawOnly
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      }
      case '--allow-delete-legacy-dirs':
        allowDeleteLegacyDirs = true;
        break;
      case '--restore': {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          restore = next;
          i++;
        } else {
          restore = true;
        }
        break;
      }
      case '--session':
        session = requireFlagValue(argv, ++i, '--session');
        break;
      case '--dir':
        dir = requireFlagValue(argv, ++i, '--dir');
        break;
      case '--limit': {
        const raw = requireFlagValue(argv, ++i, '--limit');
        // parseInt 会把 '12abc' 解成 12、负值在 llm-diff 里又被当成「全部」——都属静默误读
        if (!/^\d+$/.test(raw)) {
          throw new Error(`--limit expects a non-negative integer, got "${raw}"`);
        }
        limit = Number(raw);
        break;
      }
      default:
        positional.push(argv[i]!);
        break;
    }
  }

  return {
    command: positional[0] ?? 'help',
    subcommand: positional[1],
    config,
    port,
    help,
    verbose,
    fix,
    dryRun,
    json,
    yes,
    only,
    allowDeleteLegacyDirs,
    restore,
    session,
    dir,
    limit,
  };
}
