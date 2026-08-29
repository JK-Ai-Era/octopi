/**
 * FileWorkspace — 基于文件系统的工作区
 *
 * 提供文件操作、搜索、快照能力。
 * git 集成通过 spawn git 命令实现。
 */

import { spawn } from 'node:child_process';
import { readdir, stat, mkdir, rm, cp } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Workspace,
  WorkspaceSnapshot,
  SearchOptions,
  FileMatch,
} from '../../core/interfaces/execution-environment.js';

export interface FileWorkspaceConfig {
  root: string;
  enableGit?: boolean;
  snapshotDir?: string;
}

export class FileWorkspace implements Workspace {
  readonly root: string;
  private enableGit: boolean;
  private snapshotDir: string;

  constructor(config: FileWorkspaceConfig) {
    this.root = config.root;
    this.enableGit = config.enableGit ?? false;
    this.snapshotDir = config.snapshotDir ?? join(this.root, '.octopi', 'snapshots');
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    const id = randomUUID().slice(0, 8);
    const snapshotPath = join(this.snapshotDir, id);
    await mkdir(snapshotPath, { recursive: true });

    let commitHash: string | undefined;

    if (this.enableGit) {
      // git stash + snapshot
      commitHash = await this.execGit(['rev-parse', 'HEAD']).catch(() => undefined);
    } else {
      // 文件系统快照
      await cp(this.root, snapshotPath, {
        recursive: true,
        filter: (src) => !src.includes('.octopi') && !src.includes('node_modules') && !src.includes('.git'),
      });
    }

    return {
      id,
      createdAt: Date.now(),
      root: this.root,
      commitHash,
    };
  }

  async restore(snapshot: WorkspaceSnapshot): Promise<void> {
    if (snapshot.commitHash && this.enableGit) {
      await this.execGit(['checkout', snapshot.commitHash]);
    }
  }

  async search(pattern: string, options?: SearchOptions): Promise<FileMatch[]> {
    const matches: FileMatch[] = [];
    const limit = options?.limit ?? 100;
    const includeGlob = options?.include;
    const excludeGlob = options?.exclude;

    const walk = async (dir: string) => {
      if (matches.length >= limit) return;

      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= limit) break;

          const fullPath = join(dir, entry.name);
          const relPath = relative(this.root, fullPath);

          // 跳过隐藏目录和 node_modules
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

          // 排除过滤
          if (excludeGlob && this.globMatch(relPath, excludeGlob)) continue;

          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile()) {
            // 包含过滤
            if (includeGlob && !this.globMatch(entry.name, includeGlob)) continue;

            try {
              const { readFile } = await import('node:fs/promises');
              const content = await readFile(fullPath, 'utf-8');
              const lines = content.split('\n');

              for (let i = 0; i < lines.length; i++) {
                if (matches.length >= limit) break;
                const caseSensitive = options?.caseSensitive ?? true;
                const line = caseSensitive ? lines[i] : lines[i].toLowerCase();
                const pat = caseSensitive ? pattern : pattern.toLowerCase();

                if (line.includes(pat)) {
                  matches.push({
                    path: relPath,
                    line: i + 1,
                    content: lines[i].trim(),
                    column: line.indexOf(pat),
                  });
                }
              }
            } catch {
              // 跳过不可读文件
            }
          }
        }
      } catch {
        // 跳过不可读目录
      }
    };

    await walk(this.root);
    return matches;
  }

  async glob(pattern: string): Promise<string[]> {
    const results: string[] = [];

    const walk = async (dir: string, prefix: string) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            await walk(fullPath, relPath);
          } else if (entry.isFile()) {
            if (this.globMatch(relPath, pattern)) {
              results.push(relPath);
            }
          }
        }
      } catch {
        // skip
      }
    };

    await walk(this.root, '');
    return results;
  }

  async diff(filePath: string): Promise<string> {
    if (this.enableGit) {
      return this.execGit(['diff', '--', filePath]);
    }
    // 无 git 时返回空 diff
    return '';
  }

  async destroy(): Promise<void> {
    await rm(this.snapshotDir, { recursive: true, force: true });
  }

  // ── 内部工具 ──

  private async execGit(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, { cwd: this.root });
      let stdout = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`git ${args.join(' ')} failed (exit ${code})`));
      });
      proc.on('error', reject);
    });
  }

  private globMatch(path: string, pattern: string): boolean {
    // 简单 glob 匹配：支持 * 和 **
    const regex = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '<<GLOBSTAR>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<GLOBSTAR>>/g, '.*')
      .replace(/\?/g, '[^/]');
    return new RegExp(`^${regex}$`).test(path);
  }
}
