/**
 * ContextLayerHealth 探针
 */

import { describe, it, expect } from 'vitest';
import { probeContextLayerHealth } from '@octopi-agent/engine/harness/context/layer-health.js';
import { InMemoryMemoryStore } from '@octopi-agent/engine/harness/memory/store.js';
import { InMemoryWisdomStore } from '@octopi-agent/engine/harness/memory/wisdom.js';

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
      type: 'fact',
      content: 'x',
      source: 't',
      confidence: 0.5,
      importance: 0.5,
      tags: [],
    });
    const wisdomStore = new InMemoryWisdomStore();
    await wisdomStore.admit({
      statement: 'w',
      scenario: { problemTypes: ['通用'] },
      effect: { posture: 'p' },
      derivedFrom: { memoryIds: ['m1', 'm2'] },
      kind: 'generalize',
      origin: 'factory',
      initialStatus: 'active',
    });

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
    const { probeAgentHomeHealth } = await import('@octopi-agent/engine/harness/context/layer-health.js');
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
      const { probeAgentHomeHealth } = await import('@octopi-agent/engine/harness/context/layer-health.js');
      const health = await probeAgentHomeHealth('a4', home);
      expect(health.configured).toBe(true);
    } finally {
      const fs2 = await import('node:fs/promises');
      await fs2.rm(home, { recursive: true, force: true });
    }
  });
});
