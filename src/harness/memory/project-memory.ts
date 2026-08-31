/**
 * FileProjectMemory — 文件驱动的项目记忆
 *
 * 类似 CLAUDE.md / MEMORY.md 的项目级指令文件。
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectMemory } from './cognition-types.js';

export class FileProjectMemory implements ProjectMemory {
  readonly root: string;
  private fileName: string;

  constructor(root: string, fileName = 'MEMORY.md') {
    this.root = root;
    this.fileName = fileName;
  }

  private get filePath(): string {
    return join(this.root, this.fileName);
  }

  async load(): Promise<string> {
    try {
      await access(this.filePath);
      return await readFile(this.filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  async append(content: string): Promise<void> {
    const existing = await this.load();
    const newContent = existing ? `${existing}\n\n${content}` : content;
    await mkdir(this.root, { recursive: true });
    await writeFile(this.filePath, newContent, 'utf-8');
  }

  async update(content: string): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.filePath, content, 'utf-8');
  }
}
