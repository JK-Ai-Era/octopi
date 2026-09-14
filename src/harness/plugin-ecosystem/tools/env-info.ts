/**
 * env_info 工具 — 获取运行环境信息
 *
 * Agent 需要了解自己运行在什么环境中，以便做出正确的决策。
 * 返回操作系统、Node 版本、工作目录、平台 shell 等结构化信息。
 */

import type { RegisteredTool } from '../../../core/types.js';
import { findExecutable, resolvePlatformShell } from './platform.js';

export function createEnvInfoTool(): RegisteredTool {
  return {
    definition: {
      name: 'env_info',
      description:
        'Get runtime environment information including OS, Node.js version, working directory, PATH, platform shell, and available package managers.',
      parameters: {},
    },
    handler: async (_args, context) => {
      const os = await import('node:os');

      const shell = resolvePlatformShell();
      const detectCommand = (cmd: string): boolean => findExecutable(cmd) !== null;

      return {
        os: {
          platform: process.platform,
          arch: process.arch,
          release: os.release(),
          type: os.type(),
          homedir: os.homedir(),
          tmpdir: os.tmpdir(),
        },
        node: {
          version: process.version,
          execPath: process.execPath,
        },
        cwd: context.cwd ?? process.cwd(),
        path: process.env.PATH ?? process.env.Path ?? '',
        shell: process.env.SHELL ?? process.env.ComSpec ?? shell.executable,
        platformShell: {
          kind: shell.kind,
          executable: shell.executable,
          label: shell.label,
        },
        packageManagers: {
          npm: detectCommand('npm'),
          yarn: detectCommand('yarn'),
          pnpm: detectCommand('pnpm'),
          bun: detectCommand('bun'),
        },
      };
    },
  };
}
