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
  };
}
