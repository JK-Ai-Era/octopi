/**
 * 启动收敛（replicasPerVersion 声明式副本数）：
 * - gateway 启动按 fleet.replicasPerVersion 自举 N 个 run 实例（run-0 为首副本）
 * - serve start 提示信息解析 run 实例行（readRunInstanceLines）
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import { readRunInstanceLines } from '../src/cli/daemon.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeProvider(): ModelProvider {
  return {
    name: 'openai',
    defaultModel: 'gpt-5-mini',
    getModelInfo: (m: string) => ({ name: m }),
    getModelInfos: () => [{ name: 'gpt-5-mini' }],
    isAvailable: async () => true,
    chat: async () => ({ content: '', model: 'gpt-5-mini', finishReason: 'stop' as const }),
    stream: async function* () {
      yield { type: 'done' as const };
    },
  };
}

function makeAgent(id: string): AgentDefinition {
  return {
    id,
    home: '',
    workspace: '',
    persona: { name: id, description: '', systemPrompt: 'test' },
    tools: { allow: ['*'] },
    model: { provider: 'openai', model: 'gpt-5-mini' },
  };
}

describe('启动收敛：replicasPerVersion 自举 N 副本', () => {
  const gateways: Gateway[] = [];
  afterEach(async () => {
    for (const g of gateways) await g.stop();
    gateways.length = 0;
  });

  it('replicasPerVersion=2 → 自举 2 个 run 实例（run-0 / run-1，各带 pid+port）', async () => {
    const gateway = new Gateway(
      {
        agents: [makeAgent('assistant')],
        knowledge: { service: { manageLocal: false } },
        fleet: { replicasPerVersion: 2 },
      },
      new InMemorySessionStore(),
    );
    gateway.registerProvider(makeProvider());
    gateways.push(gateway);
    await gateway.start();

    const instances = gateway.fleetStatus().instances;
    expect(instances).toHaveLength(2);
    expect(instances.map((i) => i.instanceId).sort()).toEqual(['run-0', 'run-1']);
    for (const i of instances) {
      expect(i.pid).toBeGreaterThan(0);
      expect(i.port).toBeGreaterThan(0);
      expect(i.state).toBe('ready');
      expect(i.buildRef).toBe('self');
    }
  }, 30_000);

  it('未配置 → 缺省 1 个自举实例（行为不变）', async () => {
    const gateway = new Gateway(
      {
        agents: [makeAgent('assistant')],
        knowledge: { service: { manageLocal: false } },
      },
      new InMemorySessionStore(),
    );
    gateway.registerProvider(makeProvider());
    gateways.push(gateway);
    await gateway.start();

    expect(gateway.fleetStatus().instances).toHaveLength(1);
    expect(gateway.fleetStatus().instances[0]!.instanceId).toBe('run-0');
  }, 30_000);
});

describe('readRunInstanceLines（serve start 提示信息）', () => {
  it('解析 run 实例行；startMarker 前的旧启动行不计', () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-runlines-'));
    const logPath = join(dir, 'gateway.log');
    const marker = '--- octopi serve start 2026-11-12T07:30:00.000Z ---';
    writeFileSync(
      logPath,
      [
        '[Gateway] run instance "run-0" ready: pid=111 port=222', // 上一次启动残留
        marker,
        '[Gateway] Starting...',
        '[Gateway] run instance "run-0" ready: pid=333 port=40001',
        '[Gateway] run instance "run-1" ready: pid=444 port=40002',
        '[Gateway] run instances: 2 replica(s) up (fleet.replicasPerVersion=2)',
      ].join('\n'),
    );
    const lines = readRunInstanceLines(logPath, marker);
    expect(lines).toEqual([
      { instanceId: 'run-0', pid: '333', port: '40001' },
      { instanceId: 'run-1', pid: '444', port: '40002' },
    ]);
  });

  it('日志缺失 → 空数组（不抛）', () => {
    expect(readRunInstanceLines('/nonexistent/gateway.log', 'marker')).toEqual([]);
  });
});
