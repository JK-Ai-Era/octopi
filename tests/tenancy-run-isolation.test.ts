/**
 * T2 判据（arch/multi-tenancy.md §10）：两租户各跑 agent，互不可见家当。
 *
 * 全链：registry 记录 → 桥（物化 + 定义换装）→ AgentBuilder（tenantId 贯通）→ run
 * → 工具落盘 cwd = workspace/<tenantId>/<agentId>/ 各归各域；
 * RunScope.principal.tenantId 归属锚正确（凭证域解析的取数源）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import { InMemorySessionStore } from '@octopi-agent/engine/harness/session/in-memory-store.js';
import { getRunScope } from '@octopi-agent/engine/harness/run/run-scope.js';
import { createToolSet } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/tool-set.js';
import type { ModelProvider, LLMRequest, LLMResponse } from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message, RegisteredTool } from '@octopi-agent/core/types.js';
import type { RunConfig } from '@octopi-agent/engine/harness/run/runner.js';
import { createRegistryAgentBridge } from '../src/registry-bridge.js';
import type { AgentRecord } from '@octopi-agent/engine/harness/governance/registry/types.js';

const RAW_CONFIG = {
  models: {
    providers: {
      mock: {
        baseUrl: 'http://localhost:9/v1',
        apiKey: 'test-key',
        api: 'openai-completions',
        models: [{ id: 'm', name: 'm', contextWindow: 8000, maxTokens: 512 }],
      },
    },
  },
};

function definitionEntry(): string {
  return JSON.stringify({
    model: 'mock/m',
    persona: { name: 'n', description: 'd', systemPrompt: 'hi' },
    tools: { allow: ['*'] },
  });
}

function record(agentId: string, tenantId: string): AgentRecord {
  return {
    agentId: agentId as AgentRecord['agentId'],
    tenantId: tenantId as AgentRecord['tenantId'],
    ownerUserId: 'u-1' as AgentRecord['ownerUserId'],
    visibility: 'private',
    name: agentId,
    definition: definitionEntry(),
    homeRef: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** 脚本 provider：首调发 file_write + probe_tenant，次调收尾 */
function scriptedProvider(): ModelProvider {
  let call = 0;
  return {
    name: 'mock',
    defaultModel: 'm',
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      call++;
      if (call === 1) {
        return {
          content: '',
          model: 'm',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'c1', name: 'file_write', arguments: { path: 'note.txt', content: 'marker' } },
            { id: 'c2', name: 'probe_tenant', arguments: {} },
          ],
        };
      }
      return { content: 'done', model: 'm', finishReason: 'stop' };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
    async isAvailable() {
      return true;
    },
    getModelInfo() {
      return { name: 'm', contextWindow: 8000 };
    },
    getModelInfos() {
      return [{ name: 'm', contextWindow: 8000 }];
    },
  } as ModelProvider;
}

/** 归属探针：捕获 run 作用域的 principal.tenantId */
function probeTool(sink: Array<string | undefined>): RegisteredTool {
  return {
    definition: {
      name: 'probe_tenant',
      description: 'capture the run tenant attribution',
      parameters: {},
    },
    handler: async () => {
      sink.push(getRunScope()?.principal?.tenantId);
      return { ok: true };
    },
  };
}

describe('T2 判据：两租户各跑 agent，互不可见家当', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'tenancy-run-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('workspace 前缀隔离 + RunScope 归属锚 + 家当互不可见', async () => {
    const bridge = createRegistryAgentBridge({ getRawConfig: () => RAW_CONFIG, homeDir });
    const recA = record('agent-a', 't-a');
    const recB = record('agent-b', 't-b');
    const defA = await bridge.materialize(recA);
    const defB = await bridge.materialize(recB);

    const seenTenants: Array<string | undefined> = [];
    const store = new InMemorySessionStore();

    async function runOne(
      rec: AgentRecord,
      def: { id: string; tenantId?: string; home: string; workspace?: string },
    ): Promise<void> {
      const builder = new AgentBuilder()
        .model(scriptedProvider())
        .store(store)
        .agentId(def.id)
        .tenantId(def.tenantId!)
        .agentHome(def.home)
        .workspace(def.workspace!)
        .persona(def.home)
        // journaled 文件效应账本（file_write 的 fileEffects 前置）
        .runnerConfig({ sessionsDir: join(homeDir, 'sessions') });
      const { builtin } = createToolSet();
      for (const tool of builtin) builder.tool(tool);
      builder.tool(probeTool(seenTenants));
      const built = await builder.build();

      const sessionId = `drill:${def.id}`;
      const user: Message = { role: 'user', content: '写个文件', timestamp: Date.now() };
      const runConfig: RunConfig = {
        agentId: def.id,
        sessionId,
        systemPrompt: '',
        cwd: def.workspace!,
      };
      for await (const ev of built.runner.handle(sessionId, user, runConfig)) {
        if (ev.type === 'engine.end' || ev.type === 'engine.error') break;
      }
    }

    await runOne(recA, defA);
    await runOne(recB, defB);

    // ① 家当各归各域：文件只落在各自 workspace/<tenantId>/<agentId>/
    const noteA = join(defA.workspace!, 'note.txt');
    const noteB = join(defB.workspace!, 'note.txt');
    expect(existsSync(noteA)).toBe(true);
    expect(existsSync(noteB)).toBe(true);
    expect(readFileSync(noteA, 'utf-8')).toContain('marker');
    expect(readFileSync(noteB, 'utf-8')).toContain('marker');
    // 互不可见：A 的家当不出现在 B 的 workspace（前缀不相交）
    expect(existsSync(join(defB.workspace!, 'agent-a'))).toBe(false);
    expect(defA.workspace!.startsWith(defB.workspace!)).toBe(false);
    expect(defB.workspace!.startsWith(defA.workspace!)).toBe(false);

    // ② 归属锚：RunScope.principal.tenantId = 各自租户（凭证域解析的取数源）
    expect(seenTenants).toEqual(['t-a', 't-b']);
  }, 30_000);
});
