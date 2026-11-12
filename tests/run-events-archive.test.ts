/**
 * P1-3b run 事件归档（service-topology-p1.md §8 F④，Q3=(a)）：
 * run 终态 Hub 导出 → notify 上行 → 门面写 `<sid>.events.jsonl` 旁路 → 回放读口。
 *
 * 锚：
 * ① run_events_archived 通知落归档旁路（逐行纯数据，追加序）；
 * ② 回放读口顺序保持；无历史返回空数组（常态非错误）；
 * ③ 归档失败不阻断（观测面 fail-open）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Gateway } from '../packages/gateway/src/gateway/gateway.js';
import type { AgentDefinition } from '../packages/engine/src/harness/shared/types/agent-definition.js';

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

type NotifyCapable = {
  handleRunHostNotify: (n: unknown, instanceId: string) => Promise<void>;
};

async function makeGateway(): Promise<Gateway> {
  const gateway = new Gateway({
    agents: [makeAgent('assistant')],
    knowledge: { service: { manageLocal: false } },
  });
  await (gateway as unknown as { ensureStore(): Promise<void> }).ensureStore();
  return gateway;
}

describe('P1-3b run 事件归档（门面单写 + 回放读口）', () => {
  let home: string;
  const saved = process.env.OCTOPI_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'octopi-events-'));
    process.env.OCTOPI_HOME = home;
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.OCTOPI_HOME;
    else process.env.OCTOPI_HOME = saved;
    await rm(home, { recursive: true, force: true });
  });

  it('① notify 落归档旁路（逐行纯数据）+ ② 回放读口顺序保持', async () => {
    const gateway = await makeGateway();
    const seam = gateway as unknown as NotifyCapable;

    const events = [
      { type: 'run.started', timestamp: 1 },
      { type: 'step.end', timestamp: 2, durationMs: 5 },
      { type: 'run.completed', timestamp: 3 },
    ];
    await seam.handleRunHostNotify(
      { type: 'run_events_archived', sessionId: 's-arch', events },
      'inst-1',
    );

    // 归档旁路文件逐行可读（纯 JSON 行）
    const raw = await readFile(join(home, 'sessions', 's-arch.events.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).type).toBe('run.started');

    // 回放读口顺序保持
    const replay = await gateway.readSessionEvents('s-arch');
    expect(replay.map((e) => e.type)).toEqual(['run.started', 'step.end', 'run.completed']);
  });

  it('② 无历史返回空数组（常态非错误）', async () => {
    const gateway = await makeGateway();
    expect(await gateway.readSessionEvents('s-never')).toEqual([]);
  });

  it('① 追加语义：多次归档并存', async () => {
    const gateway = await makeGateway();
    const seam = gateway as unknown as NotifyCapable;

    await seam.handleRunHostNotify(
      { type: 'run_events_archived', sessionId: 's-multi', events: [{ type: 'a', timestamp: 1 }] },
      'inst-1',
    );
    await seam.handleRunHostNotify(
      { type: 'run_events_archived', sessionId: 's-multi', events: [{ type: 'b', timestamp: 2 }] },
      'inst-1',
    );

    const replay = await gateway.readSessionEvents('s-multi');
    expect(replay.map((e) => e.type)).toEqual(['a', 'b']);
  });

  it('③ 归档写失败不阻断（坏路径吞错 warn）', async () => {
    const gateway = await makeGateway();
    const seam = gateway as unknown as NotifyCapable;
    // 归档路径被目录占位 → appendFile 必失败（EISDIR）；调用不得抛
    await mkdir(join(home, 'sessions', 's-x.events.jsonl'), { recursive: true });
    await expect(
      seam.handleRunHostNotify(
        {
          type: 'run_events_archived',
          sessionId: 's-x',
          events: [{ type: 'a', timestamp: 1 }],
        },
        'inst-1',
      ),
    ).resolves.toBeUndefined();
  });
});
