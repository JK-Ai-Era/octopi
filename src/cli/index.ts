#!/usr/bin/env node

/**
 * Octopi CLI 入口
 */

import type { CliArgs } from './args.js';
import { parseArgs } from './args.js';
import { serveCommand, serveStopCommand } from './daemon.js';
import { webuiCommand } from './webui.js';
import { showHelp, initCommand, chatCommand, healthCommand, pluginCommand } from './commands.js';

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
    case 'serve':
      await serveCommand(args);
      break;
    case 'stop':
      await serveStopCommand();
      break;
    case 'chat':
    case 'tui':
      await chatCommand(args);
      break;
    case 'health':
      await healthCommand(args);
      break;
    case 'webui':
      await webuiCommand(args);
      break;
    case 'plugin':
      await pluginCommand(args);
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
