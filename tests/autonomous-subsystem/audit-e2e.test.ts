/**
 * 审计端到端（回归：`octopi serve` 路径 AuditWriter 从未构造，audit 目录永远为空）
 *
 * 锁的是完整链条：SubsystemRuntime(auditDir, agentId) → register → trigger →
 * `<auditDir>/<agentId>/<subsystemId>/<date>.jsonl` 真实落盘（成功与失败路径都写）。
 * wire 层的缺省/关闭口断言见 tests/harness/wire-agent-builder.test.ts。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubsystemRuntime } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/runtime.js';
import { DefaultToolBus } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/tool-bus.js';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { SubsystemSpec } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/types.js';

function makeSpec(overrides?: Partial<SubsystemSpec>): SubsystemSpec {
  return {
    id: 'audit-e2e-sub',
    name: 'Audit E2E',
    description: 'audit e2e',
    sense: { source: 'eventBus', filter: { events: ['audit.e2e'] }, isolation: 'structured' },
    think: {
      strategy: 'deterministic',
      implementation: 'code',
      handler: async () => ({ signals: [{ action: 'no-op', reason: 'done' }] }),
    },
    act: { mode: 'none' },
    signal: { severity: 'info', channel: ['event'] },
    boundary: { visibility: 'structured', authority: 'observe', security: 'sandboxed' },
    tools: { mode: 'none' },
    session: { mode: 'ephemeral', scope: 'session' },
    ...overrides,
  };
}

describe('audit end-to-end (trigger → JSONL)', () => {
  let auditDir: string;
  let runtime: SubsystemRuntime;

  beforeEach(() => {
    auditDir = mkdtempSync(join(tmpdir(), 'octopi-audit-e2e-'));
  });

  afterEach(() => {
    runtime?.dispose();
    rmSync(auditDir, { recursive: true, force: true });
  });

  function makeRuntime(): SubsystemRuntime {
    return new SubsystemRuntime({
      deps: {
        model: {} as never,
        events: new DefaultEventBus(),
        errorStrategy: {} as never,
        mainTools: new DefaultToolBus(),
      },
      auditDir,
      agentId: 'agent-a',
    });
  }

  it('writes <auditDir>/<agentId>/<subsystemId>/<date>.jsonl on success', async () => {
    runtime = makeRuntime();
    expect(runtime.register(makeSpec())).toHaveLength(0);

    const result = await runtime.trigger('audit-e2e-sub');
    expect(result.triggered).toBe(true);
    expect(result.status).toBe('success');

    const agentDir = join(auditDir, 'agent-a', 'audit-e2e-sub');
    const files = readdirSync(agentDir);
    expect(files.length).toBeGreaterThan(0);
    const lines = readFileSync(join(agentDir, files[0]!), 'utf-8').trim().split('\n');
    const record = JSON.parse(lines[0]!);
    expect(record.status).toBe('success');
  });

  it('writes an audit record on failure too', async () => {
    runtime = makeRuntime();
    expect(
      runtime.register(
        makeSpec({
          think: {
            strategy: 'deterministic',
            implementation: 'code',
            handler: async () => {
              throw new Error('boom');
            },
          },
        }),
      ),
    ).toHaveLength(0);

    const result = await runtime.trigger('audit-e2e-sub');
    expect(result.triggered).toBe(true);
    expect(result.status).toBe('failed');

    const agentDir = join(auditDir, 'agent-a', 'audit-e2e-sub');
    const files = readdirSync(agentDir);
    expect(files.length).toBeGreaterThan(0);
    const lines = readFileSync(join(agentDir, files[0]!), 'utf-8').trim().split('\n');
    const record = JSON.parse(lines[0]!);
    expect(record.status).toBe('failed');
    expect(record.error).toContain('boom');
  });
});
