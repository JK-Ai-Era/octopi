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
}

export function parseArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  let help = false;
  let verbose = false;
  let config: string | undefined;
  let port: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--config':
      case '-c':
        config = argv[++i];
        break;
      case '--port':
      case '-p':
        port = parseInt(argv[++i], 10);
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      case '--verbose':
      case '-v':
        verbose = true;
        break;
      default:
        positional.push(argv[i]);
        break;
    }
  }

  return {
    command: positional[0] ?? 'help',
    subcommand: positional[1],
    config,
    port,
    verbose,
    help,
  };
}
