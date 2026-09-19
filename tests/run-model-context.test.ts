/**
 * Run 级模型上下文（ALS）
 *
 * 行为：
 * - withRunModel 进入覆盖后，getRunModelProvider 返回绑定 provider
 * - 未进入覆盖时回退 fallback
 * - 并发 generator 互不污染
 */

import { describe, it, expect } from 'vitest';
import {
  withRunModel,
  getRunModelProvider,
  getRunModelName,
} from '../src/harness/reliability/run-model-context.js';
import { bindModelName } from '../src/harness/reliability/model-binding.js';
import type { ModelProvider } from '../src/core/interfaces/model-provider.js';

function makeProvider(name: string, defaultModel: string): ModelProvider {
  return {
    name,
    defaultModel,
    getModelInfo: (m: string) => ({ name: m, contextWindow: m.includes('mini') ? 32000 : 200000 }),
    getModelInfos: () => [{ name: defaultModel }],
    isAvailable: async () => true,
    chat: async (r) => ({ content: '', model: r.model ?? defaultModel, finishReason: 'stop' as const }),
    stream: async function* () {
      yield { type: 'done' as const };
    },
  };
}

describe('run-model-context ALS', () => {
  it('withRunModel 内可读到覆盖 provider', async () => {
    const base = makeProvider('openai', 'gpt-5.5');
    const bound = bindModelName(base, 'gpt-5-mini');

    async function* probe() {
      yield getRunModelProvider(base).defaultModel;
      yield getRunModelName();
    }

    const seen: unknown[] = [];
    for await (const v of withRunModel(bound, probe())) {
      seen.push(v);
    }
    expect(seen).toEqual(['gpt-5-mini', 'gpt-5-mini']);
  });

  it('无覆盖时回退 fallback', async () => {
    const base = makeProvider('openai', 'gpt-5.5');
    async function* probe() {
      yield getRunModelProvider(base).defaultModel;
    }
    const seen: unknown[] = [];
    for await (const v of withRunModel(undefined, probe())) {
      seen.push(v);
    }
    expect(seen).toEqual(['gpt-5.5']);
  });

  it('上下文外读不到覆盖', () => {
    const base = makeProvider('openai', 'gpt-5.5');
    expect(getRunModelProvider(base).defaultModel).toBe('gpt-5.5');
    expect(getRunModelName()).toBeUndefined();
  });

  it('并发 generator 模型互不污染', async () => {
    const base = makeProvider('openai', 'gpt-5.5');
    const a = bindModelName(base, 'model-a');
    const b = bindModelName(base, 'model-b');

    async function* probe(delayMs: number, label: string) {
      await new Promise(r => setTimeout(r, delayMs));
      yield `${label}:${getRunModelProvider(base).defaultModel}`;
    }

    const results = await Promise.all([
      (async () => {
        const out: string[] = [];
        for await (const v of withRunModel(a, probe(20, 'a'))) out.push(String(v));
        return out;
      })(),
      (async () => {
        const out: string[] = [];
        for await (const v of withRunModel(b, probe(5, 'b'))) out.push(String(v));
        return out;
      })(),
    ]);

    expect(results[0]).toEqual(['a:model-a']);
    expect(results[1]).toEqual(['b:model-b']);
  });

  it('getModelInfo 跟随覆盖模型的 contextWindow', async () => {
    const base = makeProvider('openai', 'gpt-5.5');
    const bound = bindModelName(base, 'gpt-5-mini');

    async function* probe() {
      const p = getRunModelProvider(base);
      const info = p.defaultModel ? p.getModelInfo(p.defaultModel) : null;
      yield info?.contextWindow;
    }

    const seen: unknown[] = [];
    for await (const v of withRunModel(bound, probe())) seen.push(v);
    expect(seen[0]).toBe(32000);
  });
});
