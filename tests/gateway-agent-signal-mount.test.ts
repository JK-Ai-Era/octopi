/**
 * Gateway AgentSignalSource 挂载三态 + 委派 notify 端到端送达 —— 断链回归
 *
 * 背景（2026-10-22 断链故障）：委派默认开启，而 notify 链路的接收端
 * `AgentSignalSource` 是 opt-in（仅 `agentRuntime.agentSignal: true` 或
 * `escalate.defaultAgentId` 才挂载）。配置缺省时 notifier 的通知发进
 * 无人监听的 `gatewayBus` 静默蒸发，父 agent 永远收不到子结果，
 * 且 `markNotified` 误标已送达把兜底提示也吞掉。
 *
 * 本文件守住接线契约（端到端：真实 notifier 渲染 → AgentSignalSource →
 * dispatch → 假父 agent 的 dispatcher 捕获 RunRequest 载荷）：
 * - `agentSignal` 三态：true=显式挂载 / false=显式关闭 / 缺省=委派接线时补挂
 * - 「装不装 notifier」与「挂没挂接收端」保持一致（`notifyWired`）
 * - 无接收端时投递器拒绝声称已送达（`no AgentSignalSource receiver`）
 * - 无委派部署不补挂（不为未使用委派的部署付出开销）
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { Trigger } from '@octopi-agent/engine/harness/activation/types.js';
import { createDelegationNotifier } from '@octopi-agent/engine/harness/collaboration/delegation/notifier.js';
import {
  DELEGATION_SCHEMA_VERSION,
  type Delegation,
} from '@octopi-agent/engine/harness/collaboration/delegation/types.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';

const tempDirs: string[] = [];
let prevHome: string | undefined;

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OCTOPI_HOME;
  else process.env.OCTOPI_HOME = prevHome;
  prevHome = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** 建 Gateway（OCTOPI_HOME 落临时目录、knowledge 关闭，避免污染真实运行时） */
async function makeGateway(): Promise<Gateway> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-signal-mount-'));
  tempDirs.push(dataDir);
  prevHome = process.env.OCTOPI_HOME;
  process.env.OCTOPI_HOME = dataDir;
  return new Gateway(
    { agents: [], knowledge: { service: { manageLocal: false } } },
    new InMemorySessionStore(),
  );
}

/** 最小 agent 定义（delegation 缺省 = 委派默认开启） */
function agentDef(id: string, delegation?: { callable: boolean; canDelegate: boolean }): never {
  return {
    id,
    home: join(tmpdir(), 'agent-home'),
    persona: { name: id, description: '', systemPrompt: '' },
    tools: [],
    model: { provider: 'p', model: 'm' },
    ...(delegation ? { delegation } : {}),
  } as never;
}

/** 委派终态单（进 notifier 渲染） */
function makeDelegation(): Delegation {
  return {
    id: 'del-e2e',
    parent: { agentId: 'main', sessionId: 's-parent', runId: 'r-1' },
    target: { agentId: 'child' },
    resolvedAgentId: 'child',
    task: 'research X',
    input: 'raw',
    context: 'clean',
    status: 'completed',
    output: 'found it',
    depth: 1,
    createdAt: Date.now(),
    cancelable: true,
    cascade: false,
    notified: false,
    schemaVersion: DELEGATION_SCHEMA_VERSION,
  } as Delegation;
}

/**
 * 假父 agent 的 dispatcher：捕获 RunRequest 里的触发载荷。
 *
 * 这是「父 Run 实际收到什么」的最近边界——只断言 TriggerReceived
 * 会在路由之前就成立，等于什么都没验证（评审 P2-5）。
 */
function attachCapture(gateway: Gateway, agentId: string): { payloads: string[] } {
  const payloads: string[] = [];
  gateway.getAgentRuntime().registerAgent({
    agentId,
    dispatcher: {
      execute(req: { triggers: Trigger[] }) {
        for (const t of req.triggers) {
          const content = (t.payload as { content?: string }).content;
          if (content) payloads.push(content);
        }
        return (async function* () {
          // 空事件流：Run 立即结束
        })();
      },
    },
    resolveSession: (t: Trigger) => t.sessionId ?? `${agentId}:main`,
  });
  return { payloads };
}

/** 走真实投递器发一条委派终态通知（无接收端时应拒绝声称送达） */
function fire(gateway: Gateway): void {
  const bus = (gateway as unknown as { gatewayBus: DefaultEventBus }).gatewayBus;
  createDelegationNotifier({ events: bus })(makeDelegation());
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** 触发惰性委派接线（生产中由 buildAgent 走到这里） */
function wireDelegationLazy(gateway: Gateway): Promise<{ notifyWired: boolean } | undefined> {
  return (
    gateway as unknown as {
      ensureDelegationRuntime(): Promise<{ notifyWired: boolean } | undefined>;
    }
  ).ensureDelegationRuntime();
}

describe('Gateway agentSignal 挂载三态', () => {
  it('agentSignal: true → 显式挂载，委派通知端到端送达父 dispatcher', async () => {
    const gateway = await makeGateway();
    await gateway.start();
    await gateway.configureAgentRuntime({ agentSignal: true });
    const capture = attachCapture(gateway, 'main');

    fire(gateway);
    await settle();
    expect(capture.payloads.some((c) => c.includes('<delegation_completed'))).toBe(true);
    await gateway.stop();
  });

  it('agentSignal: false 显式关闭，即使配置 escalate.defaultAgentId 也不挂', async () => {
    const gateway = await makeGateway();
    await gateway.start();
    await gateway.configureAgentRuntime({
      agentSignal: false,
      escalate: { defaultAgentId: 'main' },
    });
    const capture = attachCapture(gateway, 'main');

    // 无接收端：投递器必须拒绝声称送达（而不是默默 emit 进空总线）
    expect(() => fire(gateway)).toThrow(/no AgentSignalSource receiver/);
    await settle();
    expect(capture.payloads).toEqual([]);
    await gateway.stop();
  });

  it('agentSignal 缺省 + 委派接线 → 自动补挂接收端，notifyWired=true 且端到端送达', async () => {
    const gateway = await makeGateway();
    gateway.registerAgent(agentDef('main'));
    await gateway.start();
    await gateway.configureAgentRuntime({});

    const wiring = await wireDelegationLazy(gateway);
    expect(wiring?.notifyWired).toBe(true);
    const capture = attachCapture(gateway, 'main');

    fire(gateway);
    await settle();
    expect(capture.payloads.some((c) => c.includes('<delegation_completed'))).toBe(true);
    await gateway.stop();
  });

  it('agentSignal: false + 委派接线 → 不补挂且 notifyWired=false（poll + 提示兜底）', async () => {
    const gateway = await makeGateway();
    gateway.registerAgent(agentDef('main'));
    await gateway.start();
    await gateway.configureAgentRuntime({ agentSignal: false });

    const wiring = await wireDelegationLazy(gateway);
    expect(wiring?.notifyWired).toBe(false);
    const capture = attachCapture(gateway, 'main');

    expect(() => fire(gateway)).toThrow(/no AgentSignalSource receiver/);
    await settle();
    expect(capture.payloads).toEqual([]);
    await gateway.stop();
  });

  it('无委派部署（全部 canDelegate:false）→ 不接线也不补挂', async () => {
    const gateway = await makeGateway();
    gateway.registerAgent(agentDef('plain', { callable: true, canDelegate: false }));
    await gateway.start();
    await gateway.configureAgentRuntime({});

    const wiring = await wireDelegationLazy(gateway);
    expect(wiring).toBeUndefined();
    const capture = attachCapture(gateway, 'plain');

    expect(() => fire(gateway)).toThrow(/no AgentSignalSource receiver/);
    await settle();
    expect(capture.payloads).toEqual([]);
    await gateway.stop();
  });
});
