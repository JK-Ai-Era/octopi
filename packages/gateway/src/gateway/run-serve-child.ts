/**
 * run-serve-child — run 实例进程入口（arch/service-topology.md §4「P0b 落地形态」）。
 *
 * 模板：knowledge-serve-child（boot 纯数据交接 + ready 握手 + 优雅关闭）。
 * 通道分工：契约通道 = loopback HTTP（`POST /runs` NDJSON / `POST /control` / `GET /health`）；
 * 宿主通知 = fork IPC（RunHostNotify）。**无常驻触发面**（§5.4 结构性保证）：
 * 本入口不构造 AgentRuntime / TriggerSource / schedule tick 任何组件。
 *
 * 执行宿主装配 = RunAssembly（buildAgent 内核）+ RunHost（挂载/in-flight/退役/准入/审批桥）。
 * 构造顺序与 gateway 同源（provider → 插件宿主 → store → 装配），行为随搬迁冻结。
 */

import { readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
import type { RunBackendMountSpec } from '@octopi-agent/engine/harness/activation/run-backend.js';
import { createDelegatedLegHandle } from '@octopi-agent/engine/harness/activation/delegated-run.js';
import { assembleGlobalTools } from '@octopi-agent/engine/integration/tools/assemble.js';
import {
  skillCommandsFromManager,
  loadUserCommandDefs,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/commands/index.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import { InProcessSessionLock } from '@octopi-agent/engine/harness/run/concurrency/session-lease.js';
import { RunHost } from '@octopi-agent/engine/harness/run/run-host.js';
import type { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
import type { DelegationRuntime } from '@octopi-agent/engine/harness/collaboration/delegation/wiring.js';
import { CircuitBreaker } from '@octopi-agent/engine/harness/run/reliability/circuit-breaker.js';
import { PluginManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/manager.js';
import type {
  PluginProviderRecord,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/contribution-registry.js';
import { SessionAclService } from '@octopi-agent/engine/harness/governance/session-acl/service.js';
import { SessionScheduleService } from '@octopi-agent/engine/harness/session/schedules/service.js';
import { ObserverHub } from '@octopi-agent/engine/harness/observability/observer/hub.js';
import { createProviderFromConfig } from '@octopi-agent/engine/config.js';
import { KnowledgeClient } from '@octopi-agent/engine/harness/knowledge/client.js';
import type {
  KnowledgeStateWire,
  RunControlOp,
  RunHostNotify,
  RunStreamEntry,
} from '@octopi-agent/engine/harness/activation/run-protocol.js';
import type { RunRequest } from '@octopi-agent/engine/harness/activation/index.js';
import type { GatewayConfig } from '../types/gateway-config.js';
import { RunAssembly, toolApprovalToRequestInput } from './run-assembly.js';
import { makeKnowledgeAdmissionGate } from './gateway.js';

/** boot 文件 = gateway → run 实例的唯一交接面（纯函数数据，可单测锁 hop） */
export interface RunServeBoot {
  octopiHome: string;
  config: GatewayConfig;
  agentDefinitions: Array<Record<string, unknown>>;
  knowledge?: {
    baseUrl?: string;
    token?: string;
    state?: KnowledgeStateWire;
  };
  /** loopback HTTP 鉴权令牌（x-run-serve-token；缺省不鉴权，仅测试回环用） */
  token?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

async function main(): Promise<void> {
  const bootPath = process.argv[2];
  if (!bootPath) {
    throw new Error('run-serve-child: missing boot file argument');
  }
  const boot = JSON.parse(readFileSync(bootPath, 'utf8')) as RunServeBoot;
  const config = boot.config;

  // ── 宿主通知出口（fork IPC） ──
  const notify = (n: RunHostNotify): void => {
    if (process.send) {
      process.send({ kind: 'notify', notify: n });
    } else if (n.type === 'log') {
      console[n.level](n.message);
    }
  };

  // ── 执行宿主装配（与 gateway 构造同源；零触发面组件） ──
  const events = new DefaultEventBus();
  // session 检索投影（I2：可重建、失败不阻断权威写）——挂在写者侧 store 上；
  // 索引缺失时历史端口降级 scan-only（显式 warn，不静默）
  let sessionIndex:
    | import('@octopi-agent/engine/integration/storage/session-index.js').SessionIndexBackend
    | undefined;
  try {
    const { createSqliteSessionIndex } = await import(
      '@octopi-agent/engine/integration/storage/session-index.js'
    );
    sessionIndex = await createSqliteSessionIndex({
      dbPath: join(boot.octopiHome, 'sessions.index.db'),
    });
    await sessionIndex.ensureSchema();
  } catch (err) {
    notify({
      type: 'log',
      level: 'warn',
      message: `[RunServe] session index unavailable (scan-only search): ${err instanceof Error ? err.message : String(err)}`,
    });
    sessionIndex = undefined;
  }
  const store = new JsonlSessionStore({
    sessionsDir: join(boot.octopiHome, 'sessions'),
    ...(sessionIndex === undefined ? {} : { index: sessionIndex }),
  });
  const pluginManager = new PluginManager({
    loadPaths: config.plugins?.loadPaths ?? [],
    ...(config.plugins?.allowList === undefined ? {} : { allowList: config.plugins.allowList }),
    ...(config.plugins?.blockList === undefined ? {} : { blockList: config.plugins.blockList }),
    ...(config.plugins?.entries === undefined ? {} : { entries: config.plugins.entries }),
  });
  // 插件宿主随 run 节点（§10）：发现+导入——工具/钩子贡献在本进程执行。
  // 不 discover 则插件工具/钩子在远程模式下整体失效（fail-loud 不适用：空加载是静默降级）
  const loadedPlugins = await pluginManager.discover();
  if (loadedPlugins.length > 0) {
    notify({
      type: 'log',
      level: 'log',
      message: `[RunServe] plugins loaded: ${loadedPlugins.map((p) => p.id).join(', ')}`,
    });
  }
  const observerHub = new ObserverHub(config.observer);
  const sessionLock = new InProcessSessionLock();
  const sessionAcl = new SessionAclService(config.sessionAcl);
  const sessionSchedules = new SessionScheduleService({
    dbPath: join(boot.octopiHome, 'schedules.db'),
    events,
    ...(config.schedules?.maxOpenPerSession !== undefined
      ? { maxOpenPerSession: config.schedules.maxOpenPerSession }
      : {}),
  });
  // open 但 arm: false：schedule tick/重臂是触发面，只在 gateway（§5.4）。
  // 若此处重臂，到期作业会被本进程空 wakeup 静默消费（记账后点火无人接）。
  await sessionSchedules.open({ arm: false });

  const breakers = new Map<string, CircuitBreaker>();
  const getCircuitBreaker = (name: string): CircuitBreaker => {
    let cb = breakers.get(name);
    if (!cb) {
      cb = new CircuitBreaker({
        failureThreshold: 5,
        recoveryTimeoutMs: 30_000,
        name,
      });
      breakers.set(name, cb);
    }
    return cb;
  };

  const providers = new Map<string, ModelProvider>();
  const resolvePluginProvider = (ref: string): PluginProviderRecord | undefined =>
    pluginManager.resolveProviderFactory(ref);
  for (const [name, providerCfg] of Object.entries(config.modelProviders ?? {})) {
    const provider = await createProviderFromConfig(name, providerCfg, { resolvePluginProvider });
    providers.set(name, provider);
    notify({ type: 'log', level: 'log', message: `[RunServe] Registered provider: ${name}` });
  }

  const knowledgeClient = boot.knowledge?.baseUrl
    ? new KnowledgeClient({
        baseUrl: boot.knowledge.baseUrl,
        // KnowledgeClient 要求显式 token；boot 无 token（测试回环）时空串即无鉴权
        token: boot.knowledge.token ?? '',
      })
    : undefined;
  let knowledgeState: KnowledgeStateWire = boot.knowledge?.state ?? (knowledgeClient ? 'ready' : 'disabled');

  const defs = new Map<string, AgentDefinition>();
  for (const raw of boot.agentDefinitions) {
    const def = raw as unknown as AgentDefinition;
    defs.set(def.id, def);
  }
  const memoryRestorers = new Map<string, unknown>();

  // ── RunHost（执行核）+ RunAssembly（装配内核）──
  const host: RunHost = new RunHost({
    redispatch: (trigger) => {
      notify({ type: 'redispatch', trigger });
    },
    // 准入闸门闭包 = 单源工厂（gateway 导出；包装形状不再手抄）
    admissionGate: makeKnowledgeAdmissionGate(config.knowledge?.required, () => knowledgeState),
    sessionLock,
    notify,
    providers,
    resolveDefaultModel: (agentId) => {
      const def = defs.get(agentId);
      return def ? { provider: def.model.provider, model: def.model.model } : undefined;
    },
    loadSessionMetadata: async (sessionId) => (await store.load(sessionId))?.metadata,
    compactTargetTokens: config.context?.contextAssembler?.compactTargetTokens,
    onCompactEvent: (e) => {
      // F22 缝（对照基线 gateway buildAgent）：compact 事件不经 Runner emitObserved，
      // 须直采 Hub——但落 **run 节点自己的** ObserverHub（导出槽随 config.observer）；
      // gateway 端内存 timeline 不覆盖 run 事件（跨进程 Observer 面缺口，随 P1 归属收口，
      // 勿把 gateway 端 ingestEvent 加回来：同一导出槽会双计）。第二缝 = notify('session_event')
      // → gateway WS/store（旧 gatewayBus.emit 的跨进程形态）✓。data 为剥壳余项（不含 type/sessionId）。
      const { type, sessionId: sid, ...data } = e as {
        type: string;
        sessionId?: string;
      } & Record<string, unknown>;
      const event = {
        type,
        timestamp: Date.now(),
        sessionId: sid ?? '',
        data,
      } as unknown as AgentEvent;
      try {
        observerHub.ingestEvent(event);
      } catch {
        // 观测 fail-open（基线同语义）
      }
      notify({ type: 'session_event', sessionId: event.sessionId ?? '', event });
    },
    buildMountSpec: async (
      _agentId: string,
      definition: Record<string, unknown>,
    ): Promise<RunBackendMountSpec> => {
      const def = definition as unknown as AgentDefinition;
      defs.set(def.id, def);
      return assembly.buildMountSpec(def);
    },
    // 会话写口（写者单点 = 本进程，§3）：append/truncate 的锁语义在 RunHost
    sessionWriter: {
      load: async (sessionId) => (await store.load(sessionId)) ?? undefined,
      save: async (sessionId, session) => store.save(sessionId, session),
      patchMetadata: async (sessionId, updater) => {
        await store.updateMetadata(sessionId, updater as never);
      },
      discardFileUndo: async (sessionId, agentId) => {
        const { discardSessionFileUndo } = await import('@octopi-agent/engine');
        const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
        return discardSessionFileUndo(
          join(getOctopiHome(), 'sessions'),
          sessionId,
          memoryRestorers.get(agentId) as never,
        );
      },
    },
  });

  // 委派运行时：进程内单例（首个可委派 agent 构建时创建，close 时 dispose）。
  // 与 gateway ensureDelegationRuntime 同形——逐 agent 新建会让跨 agent 委派解析不到
  // 目标，且每次构建累积送达回执订阅。
  let delegationRuntime: DelegationRuntime | undefined;

  /**
   * 执行腿 runner 面（§9.5 S1 收口）：attach/child-run 不持裸 runner。
   * handle 经 createDelegatedLegHandle → host.startRun（准入闸门 + in-flight
   * 计数 + abort 判据 + 退役可见），目标未挂载即 get-or-mount（/runs 同语义）；
   * 其余成员委托内置 runner（RunnerChildRunPort 只消费 handle）。
   *
   * @param inner - 真实 SessionAwareRunner（非 handle 成员的原型委托目标）
   * @returns 经执行腿路由的 runner 面
   */
  const legRunner = (inner: SessionAwareRunner): SessionAwareRunner =>
    Object.create(inner, {
      handle: {
        value: createDelegatedLegHandle({
          get: (agentId) => host.get(agentId),
          ensureMounted: (agentId, definition) => host.ensureMounted(agentId, definition),
          startRun: (req, signal) => host.startRun(req, signal),
          getDefinition: (agentId) =>
            defs.get(agentId) as unknown as Record<string, unknown> | undefined,
        }),
      },
    }) as SessionAwareRunner;

  // 全局工具面（B1：§10 tool 面随执行节点）：与 daemon 同一装配工厂；
  // ask_user 走跨通道配对（host.askQuestion → notify/control）。
  const documentPort = await (async () => {
    try {
      const { createDocumentPortFromConfig } = await import(
        '@octopi-agent/engine/harness/capabilities/document/index.js'
      );
      return createDocumentPortFromConfig(config.documents);
    } catch {
      return null;
    }
  })();
  const globalTools = await assembleGlobalTools({
    providers,
    sessionHistory: {
      store,
      sessionAcl,
      archiveDir: join(boot.octopiHome, 'archives'),
      historyScope: 'participated',
      ...(sessionIndex === undefined ? {} : { index: sessionIndex }),
      resolveAgentMax: () => undefined,
    },
    documentPort,
    octopiHome: boot.octopiHome,
    summary: config.summary,
    levelMap: config.levels,
    webSearch: config.webSearch,
    requireCredentialBindings: Boolean(config.credentials?.requireBindings),
    allowPrivateNetwork: Boolean(config.security?.network?.allowPrivateNetwork),
    askUser: (question, options, context) =>
      host.askQuestion({
        sessionId: context.sessionId,
        agentId: context.agentId,
        question,
        ...(options === undefined ? {} : { options }),
      }),
  });

  const assembly: RunAssembly = new RunAssembly({
    config,
    providers,
    getCircuitBreaker,
    store,
    events,
    getPluginTools: () => pluginManager.getTools(),
    getHookPort: () => pluginManager.getHookPort(),
    globalTools,
    getObserverHub: () => observerHub,
    getSessionLock: () => sessionLock,
    getSessionAcl: () => sessionAcl,
    getSessionSchedules: () => sessionSchedules,
    getCurrentAgentDefinition: (agentId) => defs.get(agentId),
    getKnowledgeClient: async () => {
      if (!knowledgeClient) {
        throw new Error('not_implemented: run-serve-child knowledge client not configured');
      }
      return knowledgeClient;
    },
    getKnowledgeRuntime: async () => ({ state: knowledgeState }),
    requestApproval: (input) => host.askApproval(input),
    registerSkillCommands: (agentId, skillManager) => {
      // 命令面归 gateway（UI face），但**发现源**在构建侧：gateway 的启动期扫描只覆盖
      // 启动时存在的 agent，运行期新增/重建 agent 的 skill 命令必须经 commands_registered
      // 下发（否则永远不进 commandRouter——静默缺面）。
      const defs = skillCommandsFromManager(skillManager, (id) => skillManager.load(id));
      const commands = skillManager
        .list()
        .filter((skill) => skill.command)
        .flatMap((skill) => {
          const def = defs.find((d) => d.name === skill.command);
          return def ? [{ definition: def, ref: `skill:${skill.id}` }] : [];
        });
      if (commands.length > 0) {
        notify({ type: 'commands_registered', agentId, commands });
      }
    },
    registerUserCommands: (agentId, commandsDir) => {
      // 同上（用户 commands/*.md）
      const commands = loadUserCommandDefs(commandsDir);
      if (commands.length > 0) {
        notify({ type: 'commands_registered', agentId, commands });
      }
    },
    registerMemoryRestorer: (agentId, restorer) => {
      memoryRestorers.set(agentId, restorer);
    },
    onBuilt: async ({ agent, built }) => {
      // Client Tool 会话可见性：无 live client 的 tool 不进该 session 的 LLM tool 面（快照求值）
      built.agent.setToolVisibilityFilter(host.buildVisibilityPredicate());

      // 会话任务事件 → notify（gateway 转 WS；UI 只读实时面板）
      const forwardTaskEvent = (event: { sessionId?: string; type: string; data?: unknown; agentId?: string }): void => {
        if (!event.sessionId) return;
        notify({
          type: 'session_event',
          sessionId: event.sessionId,
          event: event as unknown as AgentEvent,
        });
      };
      for (const type of ['session.task.created', 'session.task.updated', 'session.task.snapshot']) {
        built.events.on(type, forwardTaskEvent);
      }

      // 委派编排：run 实例内**单** runtime（增量 attach + 停机 dispose）。
      // S1 收口（arch/service-topology.md §9.5）：attach 的 runner 经本进程执行腿
      //（host.startRun：准入闸门 + in-flight 计数 + abort 判据），子 run 对退役判据
      // 可见，不再持裸 runner。
      const { delegation, traits } = agent;
      if (delegation !== undefined) {
        const { createDelegationRuntime, effectiveDelegationPolicy } = await import(
          '@octopi-agent/engine/harness/collaboration/delegation/wiring.js'
        );
        if (effectiveDelegationPolicy(delegation).canDelegate) {
          delegationRuntime ??= createDelegationRuntime({
            events,
            notifyPush: false,
            maxActiveDelegationsPerSession: config.delegation?.maxActiveDelegationsPerSession,
          });
          delegationRuntime.attach({
            agentId: agent.id,
            agent: built.agent,
            runner: legRunner(built.runner),
            store,
            traits,
            delegation,
            persona: typeof agent.persona === 'string' ? agent.persona : undefined,
            registerTools: built.registerTools,
          });
          notify({ type: 'log', level: 'log', message: `[RunServe] Delegation wired for agent "${agent.id}" (notify push off: poll fallback)` });
        }
      }
    },
  });

  // 插件工具审批桥（与 gateway sink 同一映射；回执经 control 'approvalReply'）
  pluginManager.setToolApprovalSink(async (event, request) =>
    host.askApproval(toolApprovalToRequestInput(event, request)),
  );

  // ── 契约通道：loopback HTTP ──
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (boot.token !== undefined && req.headers['x-run-serve-token'] !== boot.token) {
          sendJson(res, 401, { ok: false, error: { message: 'run-serve-child: bad token' } });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');

        if (req.method === 'GET' && url.pathname === '/health') {
          sendJson(res, 200, { ok: true, ...(await host.health()) });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/control') {
          const op = JSON.parse(await readBody(req)) as RunControlOp;
          // compact 需已挂载执行体；未挂载即经装配懒建（get-or-mount，与 /runs 同语义）
          if (op.type === 'compact' && !host.get(op.agentId)) {
            const def = defs.get(op.agentId);
            if (!def) {
              sendJson(res, 409, {
                ok: false,
                error: { message: `Agent "${op.agentId}" not found` },
              });
              return;
            }
            await host.ensureMounted(op.agentId, def as unknown as Record<string, unknown>);
          }
          const result = await host.handleControl(op);
          sendJson(res, result.ok ? 200 : 409, result);
          return;
        }

        if (req.method === 'POST' && url.pathname === '/runs') {
          const runReq = JSON.parse(await readBody(req)) as RunRequest;
          // 消息路径 get-or-mount（gateway ensureAgentHandle 同语义）：未挂载即经装配构建+挂载，
          // 并发首建单飞（B1：并发全成功 + 竞态败者回收）。错误表面两形态：同步错 → HTTP 4xx。
          if (!host.get(runReq.agentId)) {
            const def = defs.get(runReq.agentId);
            if (!def) {
              sendJson(res, 409, {
                ok: false,
                error: { message: `Agent "${runReq.agentId}" not found` },
              });
              return;
            }
            await host.ensureMounted(runReq.agentId, def as unknown as Record<string, unknown>);
          }
          // 错误表面两形态（run-protocol）：同步错（未装载等）→ HTTP 4xx body；
          // 闸门拒/执行错 → 流内 error entry。
          let stream: AsyncIterable<AgentEvent>;
          try {
            stream = host.startRun(runReq);
          } catch (err) {
            sendJson(res, 409, {
              ok: false,
              error: { message: err instanceof Error ? err.message : String(err) },
            });
            return;
          }
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          try {
            for await (const event of stream) {
              const entry: RunStreamEntry = { type: 'event', event };
              res.write(`${JSON.stringify(entry)}\n`);
            }
            const done: RunStreamEntry = { type: 'done' };
            res.write(`${JSON.stringify(done)}\n`);
          } catch (err) {
            const entry: RunStreamEntry = {
              type: 'error',
              error: {
                message: err instanceof Error ? err.message : String(err),
                ...(err instanceof Error && err.name ? { name: err.name } : {}),
              },
            };
            res.write(`${JSON.stringify(entry)}\n`);
          }
          res.end();
          return;
        }

        sendJson(res, 404, { ok: false, error: { message: `run-serve-child: no route ${req.method} ${url.pathname}` } });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('run-serve-child: failed to bind loopback port');
  }

  // 优雅关闭：close 消息 → dispose 执行体（放后台 timer）→ 退出
  process.on('message', (msg: unknown) => {
    if ((msg as { type?: string })?.type === 'close') {
      try {
        host.disposeAll();
      } catch {
        // stop 路径 fail-open
      }
      // 委派运行时持有送达回执订阅（events 总线）：停机回收，防订阅闭包残留
      try {
        delegationRuntime?.dispose();
      } catch {
        // stop 路径 fail-open
      }
      delegationRuntime = undefined;
      server.close(() => process.exit(0));
      // 兜底：连接悬挂时强退（stop 路径不无限等）
      const t = setTimeout(() => process.exit(0), 5_000);
      t.unref();
    }
  });

  if (process.send) {
    process.send({ type: 'ready', port: address.port });
  } else {
    // 独立调试模式：无 IPC 时自报端口，boot 文件即用即删
    console.log(`[RunServe] listening on 127.0.0.1:${address.port}`);
    rmSync(bootPath, { force: true });
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (process.send) {
    process.send({ type: 'error', error: message });
  }
  console.error('[RunServe] boot failed:', message);
  process.exit(1);
});
