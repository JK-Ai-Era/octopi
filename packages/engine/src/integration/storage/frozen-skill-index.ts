/**
 * FrozenSkillIndexStore — 文件实现（session 附属目录）
 *
 * 落点 `<sessionsDir>/<sessionId>/frozen-skill-index.json`：
 * - 随 session 附属目录整体归档/删除（不进归档搬迁清单的独立文件会被漏掉）
 * - 与 state.json 聚合写回解耦——冻结是 write-once，独立文件 + link（原子
 *   no-clobber）避免与 runner 的 steps/tasks 聚合写发生读-改-写竞态。
 */

import { link, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  FrozenSkillIndex,
  FrozenSkillIndexStore,
} from '../../harness/context/skill-freeze.js';
import { assertPathSegment } from '../../paths.js';

const FROZEN_SKILL_INDEX_FILE = 'frozen-skill-index.json';

export class FileFrozenSkillIndexStore implements FrozenSkillIndexStore {
  private readonly sessionsDir: string;

  /**
   * @param sessionsDir - JsonlSessionStore 的会话目录（~/.octopi/sessions）
   */
  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  async load(sessionId: string): Promise<FrozenSkillIndex | null> {
    const target = this.filePath(sessionId);
    let raw: string;
    try {
      raw = await readFile(target, 'utf-8');
    } catch {
      // ENOENT = 首轮未冻结
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as FrozenSkillIndex;
      const shapeOk =
        Array.isArray(parsed.entries) &&
        parsed.entries.every(
          (e) =>
            e &&
            typeof e.id === 'string' &&
            typeof e.description === 'string' &&
            typeof e.filePath === 'string',
        ) &&
        typeof parsed.text === 'string' &&
        typeof parsed.frozenAt === 'number';
      if (!shapeOk) throw new Error('invalid frozen skill index shape');
      return parsed;
    } catch {
      // 损坏/旧格式：删坏文件返回 null（自愈——否则 save 的 write-once 门会
      // 永久卡在坏文件上，该会话永远「未冻结」；坏文件至少应允许被重写）
      await rm(target, { force: true }).catch(() => undefined);
      return null;
    }
  }

  async save(sessionId: string, index: FrozenSkillIndex): Promise<void> {
    const target = this.filePath(sessionId);
    // write-once：已有冻结记录即保持先到者（并发首轮只会有一个赢家）
    try {
      await stat(target);
      return;
    } catch {
      // 不存在 → 走写入
    }
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(index), 'utf-8');
    try {
      // link 是原子 no-clobber（目标存在即 EEXIST）——rename 会覆盖目标，
      // 并发首轮的后到者会赢，违反 write-once（并发写纪律：不赌写序）
      await link(tmp, target);
    } catch (err) {
      // EEXIST = 并发首轮另一方先落位：保先到者（预期内分支）；
      // 其余错误（权限/磁盘）fail-loud 上抛，不静默吞
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EEXIST') {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    } finally {
      // link 成功后 target 是独立硬链接，删 tmp 无影响
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  private filePath(sessionId: string): string {
    return join(
      this.sessionsDir,
      assertPathSegment(sessionId, 'session id'),
      FROZEN_SKILL_INDEX_FILE,
    );
  }
}
