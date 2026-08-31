/**
 * FileWisdomStore — 文件驱动的智慧存储
 *
 * P0 基础版：从 WISDOM.md 文件加载智慧。
 * P1 增强版：从反思中自动生成智慧。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  WisdomStore,
  WisdomEntry,
} from './wisdom-types.js';

export class FileWisdomStore implements WisdomStore {
  private entries: WisdomEntry[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * 从 WISDOM.md 文件加载智慧
   */
  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      // 解析 markdown 中的智慧条目（每个 ## 标题是一个条目）
      const sections = content.split(/^## /m).filter(Boolean);
      this.entries = sections.map((section, i) => {
        const lines = section.split('\n');
        const title = lines[0]?.trim() ?? '';
        const body = lines.slice(1).join('\n').trim();
        return {
          id: `wisdom-${i}`,
          content: `## ${title}\n${body}`,
          derivedFrom: [],
          priority: i, // 文件中的顺序 = 优先级
          createdAt: Date.now(),
        };
      });
    } catch {
      // 文件不存在，空智慧
      this.entries = [];
    }
  }

  async store(entry: Omit<WisdomEntry, 'id' | 'createdAt'>): Promise<string> {
    const id = randomUUID().slice(0, 8);
    this.entries.push({ ...entry, id, createdAt: Date.now() });
    return id;
  }

  async getAll(): Promise<WisdomEntry[]> {
    return [...this.entries].sort((a, b) => a.priority - b.priority);
  }

  async delete(id: string): Promise<void> {
    this.entries = this.entries.filter(e => e.id !== id);
  }

  /**
   * 保存到 WISDOM.md 文件
   */
  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const content = this.entries
      .sort((a, b) => a.priority - b.priority)
      .map(e => e.content)
      .join('\n\n');
    await writeFile(this.filePath, content, 'utf-8');
  }
}
