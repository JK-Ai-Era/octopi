/**
 * ContextLayerHealth 探针
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('语义种子装配事实为 false 时 cognition 层如实注记 degraded（R4 暂关/能力缺失）', async () => {
    const { InMemoryConceptGraph } = await import(
      '@octopi-agent/engine/harness/memory/cognition.js'
    );
    const store = new InMemoryConceptGraph();
    const health = await probeContextLayerHealth({
      agentId: 'a1b',
      cognitionStore: store,
      semanticSeedsCapable: false,
    });
    const cognition = health.layers.find((l) => l.id === 'cognition');
    expect(cognition?.registered).toBe(true);
    expect(cognition?.degraded).toContain('semantic_seeds_unavailable');
    // 装配事实为 true 或未知时不注记（不冒充能力判定）
    const capable = await probeContextLayerHealth({
      agentId: 'a1c',
      cognitionStore: store,
      semanticSeedsCapable: true,
    });
    expect(capable.layers.find((l) => l.id === 'cognition')?.degraded ?? []).toHaveLength(0);
    const unknown = await probeContextLayerHealth({ agentId: 'a1d', cognitionStore: store });
    expect(unknown.layers.find((l) => l.id === 'cognition')?.degraded ?? []).toHaveLength(0);
    // m1：未注册（无 store）的层没有装配事实可言，不注记 degraded
    const unregistered = await probeContextLayerHealth({
      agentId: 'a1e',
      semanticSeedsCapable: false,
    });
    const bare = unregistered.layers.find((l) => l.id === 'cognition');
    expect(bare?.registered).toBe(false);
    expect(bare?.degraded ?? []).toHaveLength(0);
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
  // 双层计数含共享层（OCTOPI_HOME/skills）——密封到临时 home，防真实部署数据串味
  const origOctopiHome = process.env.OCTOPI_HOME;
  let emptyHome: string;
  beforeEach(async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const { join } = await import('node:path');
    emptyHome = await fs.mkdtemp(join(os.tmpdir(), 'octopi-home-seal-'));
    process.env.OCTOPI_HOME = emptyHome;
  });
  afterEach(async () => {
    if (origOctopiHome === undefined) delete process.env.OCTOPI_HOME;
    else process.env.OCTOPI_HOME = origOctopiHome;
    const fs = await import('node:fs/promises');
    await fs.rm(emptyHome, { recursive: true, force: true });
  });

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
