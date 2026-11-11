/**
 * §11 V1：并发多实例跑不同会话零写冲突（真进程验收，service-topology-p1.md §11）。
 *
 * 判据：两个真 run 实例 + 两会话并发 run（假 LLM 即时回包）→
 * 会话文件各自完整独立（无交叉污染）、lease 各自持有（不同会话不互斥）、
 * run 双双到终态。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createServer,
  type Server,
  type AddressInfo,
} from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FleetRunBackend } from '../packages/gateway/src/gateway/supervise/fleet-backend.js';
import {
  RouteConfig,
  type InstanceRecord,
} from '../packages/gateway/src/gateway/supervise/registry.js';
import { RemoteRunBackend } from '../packages/gateway/src/gateway/remote-run-backend.js';
import type { RunServeBoot } from '../packages/gateway/src/gateway/run-serve-child.js';
import type { InstanceBackend } from '../packages/gateway/src/gateway/supervise/fleet-backend.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_REF = join(REPO_ROOT, 'packages/gateway/dist/gateway');

let home: string;
let configPath: string;
let llmServer: Server;
let llmUrl: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'octopi-v1-conc-'));
  configPath = join(home, 'octopi.json');
  writeFileSync(configPath, JSON.stringify({ agents: [] }));
  // 假 LLM：即时回一条 assistant 完成（run 一步到终态）
  llmServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'fake-1',
        object: 'chat.completion',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => llmServer.listen(0, '127.0.0.1', resolve));
  llmUrl = `http://127.0.0.1:${(llmServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => llmServer.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

function boot(): Omit<RunServeBoot, 'token'> {
  return {
    octopiHome: home,
    config: {
      agents: [],
      configPath,
      modelProviders: {
        fake: {
          api: 'openai-completions',
          baseUrl: llmUrl,
          apiKey: 'test-key',
          models: [{ id: 'test-model', name: 'test-model', contextWindow: 8192, maxTokens: 1024 }],
        },
      },
    },
    agentDefinitions: [
      { id: 'probe-agent', model: { provider: 'fake', model: 'test-model' } },
    ],
  } as unknown as Omit<RunServeBoot, 'token'>;
}

function recordOf(instanceId: string): InstanceRecord {
  return {
    instanceId,
    version: 'self',
    buildRef: 'self',
    port: 0,
    pid: -1,
    state: 'ready',
    startedAt: 0,
    load: { inFlightRuns: 0, queued: 0 },
  };
}

async function consumeRun(
  fleet: FleetRunBackend,
  sessionId: string,
  marker: string,
): Promise<{ done: boolean; error?: string }> {
  try {
    for await (const _ of fleet.startRun({
      requestId: `req-${sessionId}`,
      triggers: [{ kind: 'user' }],
      agentId: 'probe-agent',
      sessionId,
      messages: [{ role: 'user', content: marker, timestamp: Date.now() }],
    } as never)) {
      void _;
    }
    return { done: true };
  } catch (err) {
    return { done: false, error: err instanceof Error ? err.message : String(err) };
  }
}

describe('V1 并发多实例跑不同会话零写冲突', () => {
  it('两会话并发 run 各自完整独立，lease 各自持有', async () => {
    const backends: InstanceBackend[] = [];
    try {
      const b1 = await RemoteRunBackend.start(boot(), {
        buildRef: BUILD_REF,
        onNotify: () => undefined,
      });
      const b2 = await RemoteRunBackend.start(boot(), {
        buildRef: BUILD_REF,
        onNotify: () => undefined,
      });
      backends.push(b1, b2);

      const route = RouteConfig.seed({ versionPointer: 'self', replicasPerVersion: 2 });
      const fleet = new FleetRunBackend({ route });
      fleet.register({ record: recordOf('i-a'), backend: b1 });
      fleet.register({ record: recordOf('i-b'), backend: b2 });

      // 两会话并发（真进程、真写盘）
      const [r1, r2] = await Promise.all([
        consumeRun(fleet, 's-v1-a', 'hello-from-a'),
        consumeRun(fleet, 's-v1-b', 'hello-from-b'),
      ]);
      expect(r1).toEqual({ done: true });
      expect(r2).toEqual({ done: true });

      // 零写冲突：两会话各自会话文件完整 + 内容零交叉（MAJ-7 修复：Message 无
      // sessionId 字段，旧判据空转——改按会话专属内容标记查交叉）
      const rawBySid: Record<string, string> = {};
      for (const sid of ['s-v1-a', 's-v1-b']) {
        const jsonlPath = join(home, 'sessions', `${sid}.jsonl`);
        expect(existsSync(jsonlPath)).toBe(true);
        const raw = readFileSync(jsonlPath, 'utf8');
        rawBySid[sid] = raw;
        for (const line of raw.split('\n').filter((l) => l.trim().length > 0)) {
          JSON.parse(line); // 可 parse = 完整
        }
        expect(existsSync(join(home, 'sessions', `${sid}.state.json`))).toBe(true);
      }
      expect(rawBySid['s-v1-a']).not.toContain('hello-from-b'); // A 不含 B 的内容
      expect(rawBySid['s-v1-b']).not.toContain('hello-from-a'); // B 不含 A 的内容

      // lease 各自持有（不同会话不互斥）——终态已 release
      expect(fleet.isInFlight('s-v1-a')).toBe(false);
      expect(fleet.isInFlight('s-v1-b')).toBe(false);
    } finally {
      for (const backend of backends) {
        await backend.stop().catch(() => undefined);
      }
    }
  }, 60_000);
});
