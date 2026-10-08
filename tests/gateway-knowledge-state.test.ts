/**
 * Gateway.getKnowledgeState：/health 同步快照，不编造 ready
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('Gateway.getKnowledgeState', () => {
  it('未启动 → disabled', () => {
    const gateway = new Gateway({ agents: [] }, new InMemorySessionStore());
    expect(gateway.getKnowledgeState()).toBe('disabled');
  });

  it('manageLocal=false → start 后仍为 disabled（真实语义，不是假 ready）', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kn-state-'));
    tempDirs.push(dataDir);
    const prevHome = process.env.OCTOPI_HOME;
    process.env.OCTOPI_HOME = dataDir;
    try {
      const gateway = new Gateway(
        {
          agents: [],
          knowledge: { service: { manageLocal: false } },
        },
        new InMemorySessionStore(),
      );
      await gateway.start();
      expect(gateway.getKnowledgeState()).toBe('disabled');
      await gateway.stop();
    } finally {
      if (prevHome === undefined) delete process.env.OCTOPI_HOME;
      else process.env.OCTOPI_HOME = prevHome;
    }
  });

  it('manageLocal → start 后为 ready', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kn-state-ready-'));
    tempDirs.push(dataDir);
    const prevHome = process.env.OCTOPI_HOME;
    process.env.OCTOPI_HOME = dataDir;
    try {
      const gateway = new Gateway(
        {
          agents: [],
          knowledge: { service: { manageLocal: true, port: 0 } },
        },
        new InMemorySessionStore(),
      );
      await gateway.start();
      expect(gateway.getKnowledgeState()).toBe('ready');
      await gateway.stop();
    } finally {
      if (prevHome === undefined) delete process.env.OCTOPI_HOME;
      else process.env.OCTOPI_HOME = prevHome;
    }
  });
});
