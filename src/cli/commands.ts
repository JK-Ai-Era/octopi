/**
 * CLI 命令实现
 */

import { resolve, join } from 'node:path';
import { fork } from 'node:child_process';
import type { CliArgs } from './args.js';
import { loadConfig } from '../config.js';
import { initOctopi, getOctopiHome, isInitialized, formatInitReport } from '../init.js';
import { readPidFile, writePidFile, removePidFile, isProcessAlive } from './daemon.js';
import { resolveListenConfig } from './listen-config.js';
import { createProviderFromConfig } from '@octopi-agent/engine/config.js';
import enginePackage from '@octopi-agent/engine/package.json' with { type: 'json' };
import { resolveGatewayUrl, resolveGatewayApiKey, selectChatAgent } from './helpers.js';

export function showHelp(): void {
  console.log(`
Octopi — AI Agent Framework

Usage:
  octopi <command> [options]

Commands:
  init              Initialize Octopi directory structure and config
  doctor            Diagnose deployment/config issues (local rules, no LLM)
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
  plugin doctor [dir]  Check a plugin (manifest/schema, engine range, entry,
                       state-dir permissions, deployed-copy drift); --into <root>, --json
  plugin sync [dir]  Atomically deploy a plugin into OCTOPI_HOME/plugins
                       (--into <dir> to override); prints the restart notice
  ops kill <id>     Kill switch: stop ALL execution of an agent (host-side, immediate)
  ops revive <id>   Release the kill switch and resume execution
  ops status [id]   Show kill-switch state for one or all agents
  llm-diff [session]
                    Compare dumped LLM requests and locate cache-prefix breaks
  help              Show this help message

Options:
  --config, -c <path>   Config file path (default: ~/.octopi/octopi.json)
  --port, -p <port>     Port override
  --verbose, -v         Enable verbose mode (trace all engine events to file)
  --fix                 doctor: apply safe migrations (backs up config)
  --dry-run             doctor: show what --fix would do
  --json                doctor: machine-readable report (secrets redacted)
  --yes, -y             doctor: required for non-interactive --fix (apply all fixable groups)
  --only <list>         doctor: limit to domains/ids (config,layout,data,runtime)
  --restore [path]      doctor: restore octopi.json from latest (or given) backup
  --allow-delete-legacy-dirs
                        doctor: with --fix layout, rename obsolete memory/wisdom/extract dirs
  --session <id>        llm-diff: target session (default: most recently updated)
  --agent <id>          chat: agent to chat with (default: first agent in config)
  --resume <id>         chat: resume an existing session (loads recent history)
  --dir <path>          llm-diff: wire dump root (default: ~/.octopi/logs/llm-requests)
  --limit <n>           llm-diff: number of calls to show (0 = all, default 20)
  --cache-discount <r>  llm-diff: cache-hit price as a ratio of full price (default 0.1);
                        used for the aging payback estimate
  --help, -h            Show this help message

Examples:
  octopi init
  octopi doctor
  octopi doctor --fix --yes
  octopi doctor --restore
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

  // Prefer OCTOPI_HOME over cwd so a stray ./octopi.json cannot shadow workspace config
  const home = getOctopiHome();
  if (isInitialized(home)) {
    return resolve(home, 'octopi.json');
  }

  if (isInitialized(process.cwd())) return undefined;

  console.log('🐙 First run detected. Initializing Octopi...\n');
  const result = await initOctopi();
  console.log(formatInitReport(result));
  console.log('');

  return result.configPath;
}

export async function chatCommand(args: CliArgs): Promise<void> {
  const configPath = await ensureInitialized(args);
  const config = loadConfig(configPath);
  const agent = selectChatAgent(config.agents, args.agent);
  if (!agent) {
    const available = config.agents.map((a) => a.id).join(', ') || '(none)';
    console.error(
      args.agent
        ? `[Error] Agent "${args.agent}" not found in config; available: ${available}`
        : '[Error] No agents defined in config',
    );
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
    const channels = config.channels ?? [];
    const httpChannel = channels.find((c) => c.type === "http");
    // 与 daemon 监听同序（listen-config.ts）：fork 的 serve fg 子进程按配置自解析，此处必须同值
    const port = resolveListenConfig({
      gateway: (config as { gateway?: { port?: number } }).gateway,
      http: httpChannel,
    }).port;
    writePidFile({
      pid: child.pid,
      config: configPath ?? join(getOctopiHome(), 'octopi.json'),
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
    apiKey: resolveGatewayApiKey(config as unknown as Record<string, unknown>),
    resumeSessionId: args.resume,
  });
  await app.start();
}

export async function healthCommand(args: CliArgs): Promise<void> {
  const configPath = await ensureInitialized(args);
  const config = loadConfig(configPath);

  console.log('\n🏥 Health Check\n');
  // 插件 Provider（models.providers[].plugin）也需要真实工厂才能体检：
  // 临时发现一次插件（与 daemon 同一 loadPaths 语义），失败不阻断内置 provider 体检
  let resolvePluginProvider: ((ref: string) => import('@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/contribution-registry.js').PluginProviderRecord | undefined) | undefined;
  if (Object.values(config.models?.providers ?? {}).some((pc) => pc.plugin !== undefined)) {
    try {
      // 与 Gateway 同语义：loadPaths + allowList/blockList/entries 启停全部生效
      const { resolvePluginProviderOption } = await import('../config.js');
      resolvePluginProvider = (await resolvePluginProviderOption(config)).resolvePluginProvider;
    } catch (err) {
      console.warn(`  plugin discovery failed (plugin providers will FAIL): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const [providerName, providerCfg] of Object.entries(config.models?.providers ?? {})) {
    try {
      // 构造（含动态 import）与体检同置 try：单个 provider 失败只打 FAIL，不中断整轮体检
      const provider = await createProviderFromConfig(providerName, providerCfg, {
        ...(resolvePluginProvider === undefined ? {} : { resolvePluginProvider }),
      });
      const available = await provider.isAvailable();
      await provider.dispose?.();
      console.log(`  ${providerName}: ${available ? '✅ OK' : '❌ FAIL'}`);
    } catch (err) {
      console.log(`  ${providerName}: ❌ FAIL`);
      console.log(`    reason: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log();
}

export async function pluginCommand(args: CliArgs): Promise<void> {
  const rawArgs = process.argv.slice(2);
  // Value-taking flags are consumed with their value so they never leak into
  // positionals (requireFlagValue semantics: a missing value is an error).
  const VALUE_FLAGS = new Set(['--dir', '--into', '--config', '-c']);
  const positional: string[] = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.has(arg)) {
        const value = rawArgs[i + 1];
        if (value === undefined || value.startsWith('-')) {
          console.error(`plugin: ${arg} requires a value`);
          process.exit(1);
        }
        i += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  const flagValue = (flag: string): string | undefined => {
    const inline = rawArgs.find((a) => a.startsWith(`${flag}=`));
    if (inline !== undefined) return inline.slice(flag.length + 1);
    const idx = rawArgs.indexOf(flag);
    return idx >= 0 ? rawArgs[idx + 1] : undefined;
  };

  if (args.subcommand === 'doctor') {
    const { doctorPlugin } = await import('./plugin-tools.js');
    const targetDir = positional[2] ?? '.';
    const pluginsRoot = flagValue('--into');
    // The deployed copy is resolved AFTER the manifest parses — same single
    // source as the doctor checks (no second parse path here).
    let deployedDir: string | undefined;
    const probe = doctorPlugin(targetDir);
    if (probe.id !== undefined) {
      const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
      const { join } = await import('node:path');
      deployedDir = join(pluginsRoot ?? join(getOctopiHome(), 'plugins'), probe.id);
    }
    const result = probe.id !== undefined ? doctorPlugin(targetDir, deployedDir ? { deployedDir } : undefined) : probe;
    if (args.json === true) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const f of result.findings) {
        const tag = f.severity === 'ok' ? ' ok ' : f.severity.toUpperCase().padEnd(4);
        console.log(`[${tag}] ${f.id} ${f.message}`);
      }
      console.log(
        result.healthy
          ? `\nPlugin "${positional[2] ?? '.'}": source-side checks pass. Runtime policy (allow/block lists, entries.<id>.enabled, contribution conflicts) is enforced by the loader at discovery.`
          : '\nPlugin has errors — the loader will refuse it (see above).',
      );
    }
    if (!result.healthy) process.exitCode = 1;
    return;
  }

  if (args.subcommand === 'sync') {
    const { syncPlugin } = await import('./plugin-tools.js');
    const targetDir = positional[2] ?? '.';
    const pluginsRoot = flagValue('--into');
    try {
      const result = syncPlugin(targetDir, pluginsRoot);
      console.log(`🐙 Plugin "${result.id}" synced to ${result.targetDir}`);
      if (result.changedFiles.length > 0) {
        console.log(`Changed (${result.changedFiles.length}): ${result.changedFiles.slice(0, 10).join(', ')}${result.changedFiles.length > 10 ? ', …' : ''}`);
      } else {
        console.log('No content changes (copy already up to date).');
      }
      console.log(`\n⚠ ${result.restartRequired}`);
    } catch (error) {
      console.error(`plugin sync failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.subcommand !== 'init') {
    console.error('Usage: octopi plugin init <plugin-name> [--dir <path>]');
    console.error('       octopi plugin doctor [dir] [--into <plugins-root>] [--json]');
    console.error('       octopi plugin sync [dir] [--into <plugins-root>]');
    process.exit(1);
  }

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
    apiVersion: '1',
    name: `${pluginName} plugin`,
    version: '0.1.0',
    description: 'A plugin for Octopi',
    entry: './dist/index.js',
    enabledByDefault: true,
    engine: { octopi: `>=${enginePackage.version} <1` },
    configSchema: { type: 'object', additionalProperties: false },
    contributes: { tools: ['hello'] },
  };
  fs.writeFileSync(path.join(targetDir, 'octopi.plugin.json'), JSON.stringify(manifest, null, 2) + '\n');

  const entryCode = `import { definePlugin } from '@octopi-agent/engine/plugin-sdk/plugin-entry';

export default definePlugin({
  id: '${pluginName}',
  register(api) {
    api.registerTool(
      { name: 'hello', description: 'Return a greeting', parameters: {}, capabilities: ['egress'] },
      async () => 'Hello from ${pluginName}',
    );
  },
});
`;
  fs.mkdirSync(path.join(targetDir, 'src'));
  fs.writeFileSync(path.join(targetDir, 'src', 'index.ts'), entryCode);

  const pkg = {
    name: `@octopi-agent/plugin-${pluginName}`,
    version: '0.1.0',
    type: 'module',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    scripts: { build: 'tsc -p tsconfig.json' },
    peerDependencies: {
      '@octopi-agent/engine': `>=${enginePackage.version} <1`,
    },
    devDependencies: {
      '@types/node': '^24',
      typescript: '^6',
    },
  };
  fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      declaration: true,
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  };
  fs.writeFileSync(path.join(targetDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');

  console.log(`\n🐙 Plugin "${pluginName}" created at ${targetDir}\n`);
  console.log('Files:');
  console.log(`  ${targetDir}/octopi.plugin.json  ← Plugin manifest`);
  console.log(`  ${targetDir}/src/index.ts         ← Entry point`);
  console.log(`  ${targetDir}/package.json         ← Package config`);
  console.log(`  ${targetDir}/tsconfig.json         ← TypeScript config`);
  console.log('\nNext steps:');
  console.log(`  cd ${targetDir}`);
  console.log('  # Edit index.ts to add your plugin logic');
  console.log('  npm install && npm run build');
  console.log('  # Set plugins.loadPaths and plugins.entries.<id>.enabled, then restart Octopi');
}
