/**
 * ProcessSandbox — 进程级沙箱
 *
 * 通过 spawn 执行命令，施加资源限制。
 * 隔离级别：process（不依赖 Docker）。
 */

import { spawn } from 'node:child_process';
import type {
  SandboxProvider,
  SandboxConfig,
  SandboxResult,
  IsolationLevel,
  ResourceUsage,
} from '../../core/interfaces/execution-environment.js';

export class ProcessSandbox implements SandboxProvider {
  readonly level: IsolationLevel = 'process';

  async execute(command: string, config?: SandboxConfig): Promise<SandboxResult> {
    const cwd = config?.cwd ?? process.cwd();
    const env = { ...process.env, ...config?.env };
    const timeoutMs = config?.limits?.timeoutMs ?? 30_000;
    const maxOutputBytes = config?.limits?.maxOutputBytes ?? 10 * 1024 * 1024; // 10MB

    return new Promise((resolve) => {
      const start = Date.now();
      let stdout = '';
      let stderr = '';
      let terminated = false;
      let terminateReason = '';

      const proc = spawn('sh', ['-c', command], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // 收集输出
      proc.stdout.on('data', (data: Buffer) => {
        if (stdout.length + data.length > maxOutputBytes) {
          terminated = true;
          terminateReason = 'Output size limit exceeded';
          proc.kill('SIGKILL');
          return;
        }
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        if (stderr.length + data.length > maxOutputBytes) {
          return;
        }
        stderr += data.toString();
      });

      // 超时保护
      const timer = setTimeout(() => {
        terminated = true;
        terminateReason = `Execution timeout (${timeoutMs}ms)`;
        proc.kill('SIGKILL');
      }, timeoutMs);

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        const elapsedMs = Date.now() - start;

        const usage: ResourceUsage = {
          elapsedMs,
          peakMemoryBytes: -1, // 需要平台特定实现
          cpuTimeMs: -1,
          outputBytes: stdout.length + stderr.length,
        };

        resolve({
          exitCode: exitCode ?? -1,
          stdout,
          stderr,
          terminated,
          terminateReason: terminated ? terminateReason : undefined,
          usage,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: -1,
          stdout: '',
          stderr: err.message,
          terminated: true,
          terminateReason: `Process error: ${err.message}`,
          usage: {
            elapsedMs: Date.now() - start,
            peakMemoryBytes: -1,
            cpuTimeMs: -1,
            outputBytes: 0,
          },
        });
      });
    });
  }

  async isAvailable(): Promise<boolean> {
    return true; // 进程级沙箱始终可用
  }
}
