/**
 * 校准样本身份单源红线（40-engineering #8 One source of truth）
 *
 * 事故（2026-11-09，session default-web-1793794176949）：builder 的 onAfterStep handler
 * 用 `getRunScope() ?? agent.contextSessionId` 推断归属。runner 的 step_end 处理跑在
 * run 的 ALS 窗口之外，getRunScope() 拿到的是泄漏进来的外层 scope（委派子 run 经
 * 父的工具调用 spawn，父 scope 泄漏进子的事件循环；反之共享 contextSessionId 被子
 * 的 handle() 顶掉），并发委派下**双向串味**：父 usage 带子标签丢样、子 usage 带父
 * 标签错配入账，ratio 校准被毒（视图估算 160k vs 实测 314k）。
 *
 * 本测试锁住：afterStep 归属只信 notifyAfterStep 显式传入的身份，
 * 泄漏的 ALS scope 与共享 contextSessionId 一律不参与。
 */
import { describe, it, expect } from 'vitest';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import type { ContextEngine } from '@octopi-agent/engine/harness/context/types.js';
import { withRunScope, type RunScope } from '@octopi-agent/engine/harness/run/run-scope.js';
import type { ModelProvider, LLMRequest } from '@octopi-agent/core/interfaces/model-provider.js';

function mockProvider(): ModelProvider {
  return {
    name: 'mock',
    defaultModel: 'm',
    async chat(_req: LLMRequest) {
      return { content: 'ok', model: 'm', finishReason: 'stop' as const };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
    async isAvailable() {
      return true;
    },
    getModelInfo() {
      return { name: 'm', contextWindow: 32000 };
    },
    getModelInfos() {
      return [{ name: 'm', contextWindow: 32000 }];
    },
  };
}

describe('afterStep 身份单源（红线）', () => {
  it('显式身份优先于泄漏 scope 与共享 contextSessionId（并发委派串味防线）', async () => {
    const inner = new DefaultContextEngine();
    const seen: Array<{ sessionId: string; agentId?: string }> = [];
    const capturing: ContextEngine = {
      get info() {
        return inner.info;
      },
      assemble: (p) => inner.assemble(p),
      afterStep: async (p) => {
        seen.push({ sessionId: p.sessionId, agentId: p.agentId });
        await inner.afterStep?.(p);
      },
    };
    const { agent } = await new AgentBuilder()
      .model(mockProvider())
      .contextEngine(capturing)
      .buildAgent();

    // 污染 1：共享可变字段被并发子 run 顶掉（现场事故形态）
    agent.setContextSessionId('cs-CHILD');
    // 污染 2：子 run 的 ALS scope 经 spawn 泄漏进父的回调执行上下文
    const foreign: RunScope = { sessionId: 'cs-CHILD', agentId: 'default' };
    async function* leak() {
      await agent.notifyAfterStep({ sessionId: 's-parent', agentId: 'a1' }, undefined, []);
      yield 0;
    }
    for await (const _ev of withRunScope(foreign, leak())) {
      // drain
    }

    expect(seen).toEqual([{ sessionId: 's-parent', agentId: 'a1' }]);
  });
});
