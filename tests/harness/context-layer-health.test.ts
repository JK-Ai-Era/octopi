/**
 * ContextLayerHealth 探针
 */

import { describe, it, expect } from 'vitest';
import { probeContextLayerHealth } from '../../src/harness/context/layer-health.js';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import type { WisdomStore, WisdomEntry } from '../../src/harness/memory/types.js';

class TestWisdomStore implements WisdomStore {
  private entries: WisdomEntry[] = [];
  async store(entry: Omit<WisdomEntry, 'id' | 'createdAt'>): Promise<string> {
    const id = `w${this.entries.length}`;
    this.entries.push({ ...entry, id, createdAt: 1 });
    return id;
  }
  async getAll() {
    return this.entries;
  }
  async delete(id: string) {
    this.entries = this.entries.filter((e) => e.id !== id);
  }
}

describe('probeContextLayerHealth', () => {
  it('无 store 时 configured=false（personaLoaded 未显式 true）', async () => {
    const health = await probeContextLayerHealth({ agentId: 'a1' });
    expect(health.configured).toBe(false);
    const wisdom = health.layers.find((l) => l.id === 'wisdom');
    expect(wisdom?.registered).toBe(false);
  });

  it('memory/wisdom/skill 计数进入 summary', async () => {
    const memoryStore = new InMemoryMemoryStore();
    await memoryStore.store({
      type: 'preference',
      content: 'x',
      source: 't',
      confidence: 0.5,
      importance: 0.5,
      tags: [],
    });
    const wisdomStore = new TestWisdomStore();
    await wisdomStore.store({ content: 'w', derivedFrom: [], priority: 1 });

    const health = await probeContextLayerHealth({
      agentId: 'a2',
      memoryStore,
      wisdomStore,
      skillCount: 3,
      personaLoaded: true,
    });

    expect(health.configured).toBe(true);
    expect(health.summary.memory).toBe(1);
    expect(health.summary.wisdom).toBe(1);
    expect(health.summary.skills).toBe(3);
    expect(health.layers.find((l) => l.id === 'skill')?.registered).toBe(true);
  });
});

describe('probeAgentHomeHealth', () => {
  it('无 home 数据时 configured=false', async () => {
    const { probeAgentHomeHealth } = await import('../../src/harness/context/layer-health.js');
    const health = await probeAgentHomeHealth('a3', 'C:\\no\\such\\home\\octopi-test');
    expect(health.configured).toBe(false);
  });

  it('存在 skills 目录与 AGENTS.md 时 configured=true 且 persona 已加载', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const { join } = await import('node:path');
    const home = await fs.mkdtemp(join(os.tmpdir(), 'octopi-health-'));
    try {
      await fs.writeFile(join(home, 'AGENTS.md'), '# agent\n');
      await fs.mkdir(join(home, 'skills', 'demo'), { recursive: true });
      await fs.writeFile(join(home, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n');
      const { probeAgentHomeHealth } = await import('../../src/harness/context/layer-health.js');
      const health = await probeAgentHomeHealth('a4', home);
      expect(health.configured).toBe(true);
      expect(health.summary.personaLoaded).toBe(true);
      expect(health.summary.skills).toBe(1);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
