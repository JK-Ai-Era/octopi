#!/usr/bin/env node

/**
 * Octopi CLI 入口
 */

import type { CliArgs } from './args.js';
import { parseArgs } from './args.js';
import { serveCommand, serveStopCommand } from './daemon.js';
import { webuiCommand } from './webui.js';
import { showHelp, initCommand, chatCommand, healthCommand, pluginCommand, ensureInitialized } from './commands.js';
import { getOctopiHome, isInitialized } from '../init.js';
import { resolve } from 'node:path';
import { opsCommand } from './ops.js';
import { llmDiffCommand } from './llm-diff.js';
import { doctorCommand } from './doctor/index.js';
import { getSuiteVersion } from './version.js';

async function main(): Promise<void> {
  const args: CliArgs = parseArgs();

  if (args.help) {
    showHelp();
    return;
  }

  if (args.command === 'help') {
    showHelp();
    return;
  }

  // `--version` / `-v` / `octopi version`：只读构建信息，不加载配置（未初始化机器也能查版本）
  if (args.version || args.command === 'version') {
    console.log(getSuiteVersion());
    return;
  }

  // m11 拍板：裸 octopi = 未初始化→init 向导；已初始化→tui chat
  if (args.command === undefined) {
    const home = getOctopiHome();
    if (isInitialized(home) || isInitialized(process.cwd())) {
      await chatCommand({ ...args, command: 'tui' });
    } else {
      await initCommand(args);
    }
    return;
  }

  switch (args.command) {
    case 'init':
      await initCommand(args);
      break;
    case 'doctor':
      await doctorCommand(args, {
        fix: args.fix,
        dryRun: args.dryRun,
        json: args.json,
        yes: args.yes,
        only: args.only,
        allowDeleteLegacyDirs: args.allowDeleteLegacyDirs,
      });
      break;
    case 'serve':
      await serveCommand(args);
      break;
    case 'stop':
      await serveStopCommand(args);
      break;
    case 'chat':
    case 'tui':
      await chatCommand(args);
      break;
    case 'agent': {
      if (args.subcommand !== 'new') {
        console.error(`Unknown agent subcommand: ${args.subcommand ?? '(none)'} — supported: new`);
        process.exit(1);
      }
      const configPath = await ensureInitialized(args);
      const { runCreateAgentWizard } = await import('./wizard/agent-new.js');
      const created = await runCreateAgentWizard({
        octopiHome: getOctopiHome(),
        configPath: configPath ?? resolve(process.cwd(), 'octopi.json'),
      });
      if (created.launchChat) {
        await chatCommand({ ...args, command: 'chat', subcommand: undefined, target: undefined, agent: created.agentId });
      }
      break;
    }
    case 'health':
      await healthCommand(args);
      break;
    case 'webui':
      await webuiCommand(args);
      break;
    case 'browser': {
      const { browserCommand } = await import('./browser.js');
      await browserCommand(args);
      break;
    }
    case 'plugin':
      await pluginCommand(args);
      break;
    case 'ops':
      await opsCommand(args);
      break;
    case 'skill': {
      const { skillCommand } = await import('./skill.js');
      await skillCommand(args);
      break;
    }
    case 'llm-diff':
    case 'llmDiff':
      await llmDiffCommand(args);
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[Fatal] ${error.message}`);
  process.exit(1);
});
