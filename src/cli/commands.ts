/**
 * CLI 命令实现
 */

import { resolve, join } from 'node:path';
import { fork } from 'node:child_process';
import type { CliArgs } from './args.js';
import { loadConfig } from '../config.js';
import { initOctopi, getOctopiHome, isInitialized, formatInitReport } from '../init.js';
import { readPidFile, writePidFile, removePidFile, isProcessAlive, ensureDaemonConfig, createProvider } from './daemon.js';
import { resolveGatewayUrl } from './helpers.js';

export function showHelp(): void {
  console.log(`
Octopi — AI Agent Framework

Usage:
  octopi <command> [options]

Commands:
  init              Initialize Octopi directory structure and config
  serve start       Start the Gateway server (background daemon)
  serve stop        Stop the Gateway server
  serve restart     Restart the Gateway server
  serve status      Show Gateway server status
  serve fg          Start the Gateway server in foreground (for debugging)
  chat  (or tui)        Interactive TUI chat with an agent
  health            Check the health of configured providers
  webui start       Start the Web UI server
  webui stop        Stop the Web UI server
  webui restart     Restart the Web UI server
  webui status      Show Web UI server status
  plugin init       Scaffold a new plugin project
  help              Show this help message

Options:
  --config, -c <path>   Config file path (default: ./octopi.json)
  --port, -p <port>     Port override
  --verbose, -v         Enable verbose mode (trace all engine events to file)
  --help, -h            Show this help message

Examples:
  octopi init
  octopi serve start -c ./my-config.json
  octopi serve stop
  octopi serve restart
  octopi serve status
  octopi serve fg -c ./my-config.json   # foreground mode
  octopi chat -c ./my-config.json
  octopi health -c ./my-config.json
`);
}

export async function initCommand(args: CliArgs): Promise<void> {
  const homeDir = args.config ? resolve(args.config, '..') : undefined;
  const result = await initOctopi(homeDir);
  console.log(formatInitReport(result));
}

export async function ensureInitialized(args: CliArgs): Promise<string | undefined> {
  if (args.config) return args.config;

  if (isInitialized(process.cwd())) return undefined;

  const home = getOctopiHome();
  if (isInitialized(home)) {
    return resolve(home, 'octopi.json');
  }

  console.log('🐙 First run detected. Initializing Octopi...\n');
  const result = await initOctopi();
  console.log(formatInitReport(result));
  console.log('');

  return result.configPath;
}

export async function chatCommand(args: CliArgs): Promise<void> {
  const configPath = await ensureInitialized(args);
  const config = loadConfig(configPath);
  const agent = config.agents[0];
  if (!agent) {
    console.error('[Error] No agents defined in config');
    process.exit(1);
  }

  let pidFile = readPidFile();
  let gatewayRunning = pidFile && isProcessAlive(pidFile.pid);

  if (!gatewayRunning) {
    console.log('[TUI] Gateway not running, starting...');
    removePidFile();
    const childArgs = ['serve', 'fg'];
    if (configPath) childArgs.push('--config', configPath);
    const child = fork(process.argv[1], childArgs, {
      detached: true,
      stdio: 'ignore',
      execArgv: [],
      env: { ...process.env, OCTOPI_DAEMON: '1' },
    });
    child.unref();
    if (!child.pid) {
      console.error('❌ Failed to start Gateway');
      process.exit(1);
    }
    const channels = (config.channels ?? []) as Array<Record<string, unknown>>;
    const httpChannel = channels.find((c) => c.type === 'http') as Record<string, unknown> | undefined;
    const port = (httpChannel?.port as number) ?? 3000;
    writePidFile({
      pid: child.pid,
      config: configPath ?? join(process.cwd(), 'octopi.json'),
      port,
      startedAt: new Date().toISOString(),
    });
    console.log('[TUI] Waiting for Gateway to start...');
    const gatewayUrl = `http://localhost:${port}`;
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          ready = true;
          break;
        }
      } catch { /* not ready yet */ }
    }
    if (!ready) {
      console.error('❌ Gateway failed to start within 15 seconds');
      process.exit(1);
    }
    console.log(`[TUI] Gateway started (PID: ${child.pid})`);
    pidFile = readPidFile();
  } else {
    console.log(`[TUI] Gateway detected (PID: ${pidFile!.pid})`);
  }

  const gatewayUrl = resolveGatewayUrl(config as unknown as Record<string, unknown>);

  const { TuiApp } = await import('../integration/tui/app.js');
  const app = new TuiApp({
    agentId: agent.id,
    gatewayUrl,
  });
  await app.start();
}

export async function healthCommand(args: CliArgs): Promise<void> {
  const configPath = await ensureInitialized(args);
  const config = loadConfig(configPath);

  console.log('\n🏥 Health Check\n');
  for (const [providerName, providerCfg] of Object.entries(config.models?.providers ?? {})) {
    const provider = createProvider(providerName, providerCfg);
    if (provider) {
      try {
        const available = await provider.isAvailable();
        console.log(`  ${providerName}: ${available ? '✅ OK' : '❌ FAIL'}`);
      } catch {
        console.log(`  ${providerName}: ❌ FAIL`);
      }
    }
  }
  console.log();
}

export async function pluginCommand(args: CliArgs): Promise<void> {
  if (args.subcommand !== 'init') {
    console.error('Usage: octopi plugin init <plugin-name> [--dir <path>]');
    process.exit(1);
  }

  const rawArgs = process.argv.slice(2);
  const positional = rawArgs.filter((a) => !a.startsWith('-'));
  const pluginName = positional[2];
  const dirIdx = rawArgs.indexOf('--dir');
  const dirFlag = dirIdx >= 0 ? rawArgs[dirIdx + 1] : undefined;

  if (!pluginName) {
    console.error('Usage: octopi plugin init <plugin-name> [--dir <path>]');
    process.exit(1);
  }

  const targetDir = dirFlag ?? `./plugins/${pluginName}`;
  const fs = await import('node:fs');
  const path = await import('node:path');

  if (fs.existsSync(targetDir)) {
    console.error(`Directory already exists: ${targetDir}`);
    process.exit(1);
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const manifest = {
    id: pluginName,
    name: `${pluginName} plugin`,
    version: '0.1.0',
    description: 'A plugin for Octopi',
    main: 'index.js',
    enabledByDefault: true,
  };
  fs.writeFileSync(path.join(targetDir, 'octopi.plugin.json'), JSON.stringify(manifest, null, 2) + '\n');

  const entryCode = `/**
 * ${pluginName} plugin
 */

import { definePluginEntry } from 'octopi/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: '${pluginName}',
  name: '${pluginName}',
  description: 'A plugin for Octopi',

  register(api) {
    console.log('[${pluginName}] Registered');
  },
});
`;
  fs.writeFileSync(path.join(targetDir, 'index.ts'), entryCode);

  const pkg = {
    name: `@octopi/plugin-${pluginName}`,
    version: '0.1.0',
    type: 'module',
    main: 'index.js',
    types: 'index.d.ts',
    peerDependencies: {
      octopi: '>=0.4.0',
    },
  };
  fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      declaration: true,
      outDir: '.',
      rootDir: '.',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ['*.ts'],
  };
  fs.writeFileSync(path.join(targetDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');

  console.log(`\n🐙 Plugin "${pluginName}" created at ${targetDir}\n`);
  console.log('Files:');
  console.log(`  ${targetDir}/octopi.plugin.json  ← Plugin manifest`);
  console.log(`  ${targetDir}/index.ts             ← Entry point`);
  console.log(`  ${targetDir}/package.json         ← Package config`);
  console.log(`  ${targetDir}/tsconfig.json         ← TypeScript config`);
  console.log('\nNext steps:');
  console.log(`  cd ${targetDir}`);
  console.log('  # Edit index.ts to add your plugin logic');
  console.log('  # Add plugins.loadPaths to your octopi.json config');
}
