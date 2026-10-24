/**
 * toGatewayConfig 顶层配置映射守卫（防「静默丢配置」复发）
 *
 * 背景：`toGatewayConfig()`（src/config.ts）是 CLI→Gateway 的显式映射边界，
 * 对象字面量漏字段 = octopi.json 配了也静默丢弃。agent 级键已有守卫
 * （config-gateway-effect-policy.test.ts），本文件守卫**顶层键**：
 * 已实际丢过 subsystems / cognition / wisdom / documents / schedules / plugins / concurrency。
 *
 * 规则：engineConfigSchema 的每个顶层键必须在 CLASSIFICATION 表中显式分类：
 * - mapped       → toGatewayConfig 必须映射到 target 字段（填值后输出非 undefined）
 * - host-consumed → 宿主（daemon/CLI）直接消费，不经 GatewayConfig（注明消费方）
 * - ignored      → 声明但当前无消费方（注明理由 + KNOWN-ISSUES 跟踪）
 * 新增顶层键未分类、或分类表出现过期条目，本测试即失败。
 */

import { describe, it, expect } from 'vitest';
import { toGatewayConfig } from '../src/config.js';
import type { NormalizedHarnessConfig, AgentConfig } from '../src/config.js';
import { OctopiConfigSchema } from '../src/config-schema/index.js';

type Classification =
  | { kind: 'mapped'; target: string; targets?: string[] }
  | { kind: 'host-consumed'; where: string }
  | { kind: 'ignored'; reason: string };

const CLASSIFICATION: Record<string, Classification> = {
  agents: { kind: 'mapped', target: 'agents' },
  models: {
    kind: 'mapped',
    target: 'levels',
    // models 段拆三路映射：providers→modelProviders、level→levels、embedding→embedding
    targets: ['levels', 'modelProviders', 'embedding'],
  },
  defaults: { kind: 'host-consumed', where: 'resolveModelConfig (src/config.ts)' },
  plugins: { kind: 'mapped', target: 'plugins' },
  budgetPolicy: { kind: 'mapped', target: 'budgetPolicy' },
  runGuard: { kind: 'mapped', target: 'runGuard' },
  modelCall: { kind: 'mapped', target: 'modelCallIdleTimeoutMs' },
  agentRuntime: { kind: 'mapped', target: 'agentRuntime' },
  schedules: { kind: 'mapped', target: 'schedules' },
  contextEngine: { kind: 'mapped', target: 'contextEngine' },
  contextAssembler: { kind: 'mapped', target: 'contextAssembler' },
  summary: { kind: 'host-consumed', where: 'daemon SummaryPort wiring (src/cli/daemon.ts)' },
  compact: {
    kind: 'ignored',
    reason: 'compact 能力缺省键声明了但无消费方；见 docs/KNOWN-ISSUES.md',
  },
  documents: { kind: 'mapped', target: 'documents' },
  knowledge: { kind: 'mapped', target: 'knowledge' },
  context: { kind: 'mapped', target: 'context' },
  constitution: { kind: 'mapped', target: 'constitution' },
  memory: { kind: 'mapped', target: 'memory' },
  subsystems: { kind: 'mapped', target: 'subsystems' },
  cognition: { kind: 'mapped', target: 'cognition' },
  wisdom: { kind: 'mapped', target: 'wisdom' },
  security: { kind: 'mapped', target: 'security' },
  credentials: { kind: 'mapped', target: 'credentials' },
  channels: { kind: 'host-consumed', where: 'daemon channel listener (src/cli/daemon.ts)' },
  session: { kind: 'mapped', target: 'session' },
  toolIsolation: { kind: 'mapped', target: 'toolIsolation' },
  effectPolicy: { kind: 'mapped', target: 'effectPolicy' },
  sessionAcl: { kind: 'mapped', target: 'sessionAcl' },
  fileSend: { kind: 'mapped', target: 'fileSend' },
  observability: { kind: 'mapped', target: 'observability' },
  observer: { kind: 'mapped', target: 'observer' },
  concurrency: { kind: 'mapped', target: 'concurrency' },
  webSearch: { kind: 'host-consumed', where: 'daemon web_search factory (src/cli/daemon.ts)' },
  delegation: { kind: 'mapped', target: 'delegation' },
  gateway: {
    kind: 'ignored',
    reason: '规划中的 Gateway 覆盖段（port/host/debugRest），产品无消费方（daemon 读 args.port/channels）；见 docs/KNOWN-ISSUES.md',
  },
  web: { kind: 'host-consumed', where: 'daemon listenHost + octopi webui start (src/cli/daemon.ts, src/cli/webui.ts)' },
};

function agentConfig(): AgentConfig {
  return {
    id: 'default',
    home: '/tmp/octopi/agents/default',
    workspace: '/tmp/octopi/workspace/default',
    model: { provider: 'test', model: 'm1' },
  };
}

/** 每个 mapped 顶层键都填哨兵值，一次映射后逐项断言 */
function fullyPopulatedConfig(): NormalizedHarnessConfig {
  return {
    models: {
      providers: { test: {} },
      level: { mini: { primary: 'test/m1' } },
      embedding: { provider: 'test', model: 'e1' },
    },
    flatModels: [],
    agents: [agentConfig()],
    plugins: { loadPaths: ['/tmp/plugins'] },
    budgetPolicy: { maxIterations: 5 },
    runGuard: { enabled: true },
    modelCall: { idleTimeoutMs: 1000 },
    agentRuntime: { coalesceWindowMs: 10 },
    schedules: { maxOpenPerSession: 3 },
    contextEngine: { protectFirstN: 2 },
    contextAssembler: { preview: true },
    documents: { extract: { enabled: true } },
    knowledge: { recall: 'hybrid' },
    context: { constitution: { mode: 'product' } },
    constitution: { mode: 'product' },
    memory: { retrieval: { minSimilarity: 0.5 } },
    subsystems: { auditDir: '/tmp/audit', allowlist: ['memory.steward.*'] },
    cognition: { enabled: true },
    wisdom: { enabled: true },
    security: { enforce: 'block' },
    credentials: { requireBindings: true },
    session: { dmScope: 'per-peer' },
    toolIsolation: 'session-subdir',
    effectPolicy: { mode: 'project' },
    sessionAcl: {},
    fileSend: { maxBytes: 1024 },
    observability: { level: 3, traceDir: '/tmp/traces' },
    observer: {},
    concurrency: { providerPool: { slots: [{ provider: 'test' }] } },
    delegation: { maxActiveDelegationsPerSession: 2 },
  } as unknown as NormalizedHarnessConfig;
}

describe('toGatewayConfig top-level mapping guard (no silent drop)', () => {
  it('every OctopiConfigSchema top-level key is explicitly classified', () => {
    const schemaKeys = Object.keys(OctopiConfigSchema.shape);
    const unclassified = schemaKeys.filter((k) => !(k in CLASSIFICATION));
    expect(
      unclassified,
      `新增顶层配置键未分类（在 CLASSIFICATION 中声明 mapped/host-consumed/ignored）：${unclassified.join(', ')}`,
    ).toEqual([]);
  });

  it('classification table has no stale entries', () => {
    const schemaKeys = new Set(Object.keys(OctopiConfigSchema.shape));
    const stale = Object.keys(CLASSIFICATION).filter((k) => !schemaKeys.has(k));
    expect(stale, `分类表存在过期条目（键已从 schema 移除）：${stale.join(', ')}`).toEqual([]);
  });

  it('every mapped key lands on the gateway config (non-undefined)', () => {
    const gw = toGatewayConfig(fullyPopulatedConfig()) as unknown as Record<string, unknown>;
    const dropped: string[] = [];
    for (const [key, cls] of Object.entries(CLASSIFICATION)) {
      if (cls.kind !== 'mapped') continue;
      for (const target of cls.targets ?? [cls.target]) {
        if (gw[target] === undefined) {
          dropped.push(`${key} → ${target}`);
        }
      }
    }
    expect(dropped, `toGatewayConfig 静默丢弃这些顶层键：${dropped.join(', ')}`).toEqual([]);
  });

  it('subsystems / cognition / wisdom survive verbatim (the original bugs)', () => {
    const gw = toGatewayConfig(fullyPopulatedConfig());
    expect(gw.subsystems).toEqual({
      auditDir: '/tmp/audit',
      allowlist: ['memory.steward.*'],
    });
    expect(gw.cognition).toEqual({ enabled: true });
    expect(gw.wisdom).toEqual({ enabled: true });
  });

  it('subsystems.auditDir:false (audit off switch) survives the boundary', () => {
    const gw = toGatewayConfig(
      fullyPopulatedConfig(),
    );
    expect(gw.subsystems?.auditDir).toBe('/tmp/audit');

    const off = toGatewayConfig({
      ...fullyPopulatedConfig(),
      subsystems: { auditDir: false },
    } as unknown as NormalizedHarnessConfig);
    expect(off.subsystems?.auditDir).toBe(false);
  });
});
