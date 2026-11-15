#!/usr/bin/env node

/**
 * Octopi CLI 入口
 */

import type { CliArgs } from './args.js';
import { parseArgs } from './args.js';
import { serveCommand, serveStopCommand } from './daemon.js';
import { webuiCommand } from './webui.js';
import { showHelp, initCommand, chatCommand, healthCommand, pluginCommand, ensureInitialized } from './commands.js';
import { getOctopiHome } from '../init.js';
import { resolve } from 'node:path';
import { opsCommand } from './ops.js';
import { llmDiffCommand } from './llm-diff.js';
import { doctorCommand } from './doctor/index.js';

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
    case 'plugin':
      await pluginCommand(args);
      break;
    case 'ops':
      await opsCommand(args);
      break;
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
