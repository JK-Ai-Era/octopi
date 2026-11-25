/**
 * Skill 中途刷新测试（设计 §7 实测修正 + 评审 B1/M1/M2/M3/M4/M5/M6 修复）
 *
 * 覆盖：文件面脏检、registry 戳脏检、discover 原子 swap、无变化短路、
 * 附件变更触发重扫（M3）、闸门报错保留旧条目（M2b）、真实 registry 链（M6）、
 * 增量链路（M6：getEntries→ensureFresh 进 delta）
 */
import { describe, test, expect, vi } from 'vitest';
import { DefaultSkillManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/manager.js';
import type { SkillAdmissionGate } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/lifecycle.js';
import { SkillLifecycle } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/lifecycle.js';
import { SkillStateDatabase } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/registry.js';
import { hashSkillDir } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/hash.js';
import type { SkillDefinition } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/types.js';
import { SkillDeltaLayer } from '@octopi-agent/engine/harness/context/layers.js';
import type {
  FrozenSkillIndex,
  FrozenSkillIndexStore,
} from '@octopi-agent/engine/harness/context/skill-freeze.js';
import type { SkillIndexEntry } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/index-render.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function writeSkill(root: string, id: string): void {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(
    join(root, id, 'SKILL.md'),
    `---\nname: "${id}"\ndescription: "test skill ${id}"\n---\n\n# ${id}\n\nbody\n`,
  );
}

function toEntry(s: SkillDefinition): SkillIndexEntry {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    filePath: s.filePath,
    requiredTools: s.requiredTools,
  };
}

const ctx = (sessionId = 's1') => ({
  sessionId,
  messages: [],
  query: 'q',
  tokenBudget: 4096,
  systemBudget: 8192,
});

describe('中途索引刷新（ensureFresh / refresh）', () => {
  test('文件面脏检：中途新增的技能在消费入口即刻可见', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-refresh-'));
    try {
      writeSkill(root, 'skill-a');
      const mgr = new DefaultSkillManager();
      await mgr.discover([root]);
      expect(mgr.list().map((s) => s.id)).toEqual(['skill-a']);

      writeSkill(root, 'skill-b');
      // 无刷新时 b 不在构建期快照；load 入口自刷新后即刻可见
      const loaded = await mgr.load('skill-b');
      expect(loaded.status).toBe('ok');
      expect(mgr.list().map((s) => s.id).sort()).toEqual(['skill-a', 'skill-b']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('registry 戳脏检：停用（无文件变化）后技能离场、再启用回归', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-refresh-'));
    try {
      writeSkill(root, 'skill-a');
      let stamp = '1';
      let admitted = true;
      const gate: SkillAdmissionGate = {
        admit: () => (admitted ? { admitted: true } : { admitted: false, reason: 'disabled' }),
        registryStamp: () => stamp,
      };
      const mgr = new DefaultSkillManager(undefined, { gate });
      await mgr.discover([root]);
      expect(mgr.get('skill-a')).not.toBeNull();

      admitted = false;
      stamp = '2';
      await mgr.ensureFresh();
      expect(mgr.get('skill-a')).toBeNull();
      expect((await mgr.load('skill-a')).status).toBe('not_found');

      admitted = true;
      stamp = '3';
      await mgr.ensureFresh();
      expect(mgr.get('skill-a')).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('discover 原子 swap：重建在途索引不出现半空视图', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-refresh-'));
    try {
      writeSkill(root, 'skill-a');
      writeSkill(root, 'skill-b');
      const mgr = new DefaultSkillManager();
      await mgr.discover([root]);
      // 删除 b 并发起重建（重建在途）——旧索引视图必须仍完整（不是半空 map）。
      // 断言 get 而非 consume：consume 还要读盘，b 已删则 unreadable 拒是正确
      // fail-closed，与 swap 原子性无关
      rmSync(join(root, 'skill-b'), { recursive: true, force: true });
      const rebuilding = mgr.discover([root]);
      expect(mgr.get('skill-b')).not.toBeNull();
      expect(mgr.get('skill-a')).not.toBeNull();
      await rebuilding;
      expect(mgr.get('skill-b')).toBeNull();
      expect(mgr.get('skill-a')).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('无变化短路：签名相同不重扫（M5 判别力：spy 断言 discover 未被调用）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-refresh-'));
    try {
      writeSkill(root, 'skill-a');
      const mgr = new DefaultSkillManager();
      await mgr.discover([root]);
      const spy = vi.spyOn(mgr, 'discover');
      await mgr.ensureFresh();
      expect(spy).not.toHaveBeenCalled();
      expect(mgr.get('skill-a')).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('评审修复回归（M2b/M3/M6）', () => {
  test('M3：附件内容变更触发重扫（hash_drift 收敛的前提）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-refresh-'));
    try {
      writeSkill(root, 'skill-a');
      writeFileSync(join(root, 'skill-a', 'note.md'), 'v1');
      const mgr = new DefaultSkillManager();
      await mgr.discover([root]);
      const spy = vi.spyOn(mgr, 'discover');
      // 附件改内容（SKILL.md 不动）：M3 修复前签名只看 SKILL.md = 永不重扫
      writeFileSync(join(root, 'skill-a', 'note.md'), 'v2-longer');
      await mgr.ensureFresh();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('M2b：闸门报错保留旧条目、新面孔 fail-closed（db 抖动不换空索引）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-refresh-'));
    try {
      writeSkill(root, 'skill-a');
      let fail = false;
      const gate: SkillAdmissionGate = {
        admit: () => {
          if (fail) throw new Error('db down');
          return { admitted: true };
        },
      };
      const mgr = new DefaultSkillManager(undefined, { gate });
      await mgr.discover([root]);
      expect(mgr.get('skill-a')).not.toBeNull();

      fail = true;
      writeSkill(root, 'skill-b'); // 文件面变化触发重扫，此时闸门报错
      await mgr.ensureFresh();
      expect(mgr.get('skill-a')).not.toBeNull(); // 旧条目保留
      expect(mgr.get('skill-b')).toBeNull(); // 新面孔 fail-closed
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('M6：真实 registry 链——setEnabled 经 registryStamp 驱动可见性', async () => {
    const home = mkdtempSync(join(tmpdir(), 'skill-refresh-home-'));
    const root = join(home, 'skills');
    mkdirSync(root, { recursive: true });
    writeSkill(root, 'skill-a');
    const db = await SkillStateDatabase.create({ dbPath: join(home, 'skills.db') });
    const lifecycle = new SkillLifecycle({ db, octopiHome: home, agentId: 'default' });
    // 放盘即信任：dropped-in 自动登记（approved+enabled+unreviewed）
    const admission = lifecycle.admit({
      skillId: 'skill-a',
      contentHash: hashSkillDir(join(root, 'skill-a')),
    });
    expect(admission.admitted).toBe(true);
    const mgr = new DefaultSkillManager(undefined, { gate: lifecycle, loadGuard: lifecycle });
    await mgr.discover([root]);
    expect(mgr.get('skill-a')).not.toBeNull();

    // setEnabled 无文件面痕迹——只有 registryStamp 能让其被看见
    await new Promise((r) => setTimeout(r, 5)); // 同 ms 戳粒度（m1 已知边界）
    lifecycle.setEnabled('skill-a', false);
    await mgr.ensureFresh();
    expect(mgr.get('skill-a')).toBeNull();

    await new Promise((r) => setTimeout(r, 5)); // 同 ms 戳粒度（m1 已知边界）
    lifecycle.setEnabled('skill-a', true);
    await mgr.ensureFresh();
    expect(mgr.get('skill-a')).not.toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  test('M6：增量链路——中途新增经 getEntries→ensureFresh 进 delta', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-refresh-'));
    try {
      writeSkill(root, 'skill-a');
      const mgr = new DefaultSkillManager();
      await mgr.discover([root]);
      const frozen: FrozenSkillIndex = {
        entries: mgr.list().map(toEntry),
        text: 'frozen',
        frozenAt: Date.now(),
      };
      const store = { load: async () => frozen } as unknown as FrozenSkillIndexStore;
      // 复刻 builder 闭包形态（ensureFresh + list）——闭包删掉 ensureFresh 此测应红
      const getEntries = async () => {
        await mgr.ensureFresh?.();
        return mgr.list().map(toEntry);
      };
      const deltaLayer = new SkillDeltaLayer({ store, getEntries });
      expect(await deltaLayer.assemble(ctx())).toBeNull(); // 无变化无 delta

      writeSkill(root, 'skill-b');
      const content = await deltaLayer.assemble(ctx());
      expect(content).not.toBeNull();
      expect(JSON.stringify(content)).toContain('skill-b'); // 中途新增进增量块
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
