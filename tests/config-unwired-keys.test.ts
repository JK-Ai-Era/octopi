/**
 * 未接线配置键检测（src/config-schema/unwired-keys.ts）
 *
 * 守卫两类静默失效：
 * 1. 表漂移——消费方实现后表未收窄（配置键被误报"未接线"）；
 * 2. 表缺漏——新声明的未接线键未补行（回归"配了不生效且无告警"）。
 * 每个断言都对应 docs/KNOWN-ISSUES.md 的跟踪面。
 */
import { describe, it, expect } from 'vitest';
import { detectUnwiredConfigKeys } from '../src/config-schema/unwired-keys.js';

describe('detectUnwiredConfigKeys', () => {
  it('reports documented unwired keys (KNOWN-ISSUES tracking surface)', () => {
    const raw = {
      compact: { defaultProtectHead: 5, defaultProtectTail: 20, defaultTargetTokens: 4000, defaultMode: 'auto' },
      models: { mode: 'replace' },
      plugins: { loadPaths: ['./p'], configs: { myplug: { a: 1 } } },
      knowledge: {
        required: true,
        attachments: {
          inject: { recallTopK: 5, inventory: true },
          tools: { attachmentsRootReadOnly: true },
        },
      },
      gateway: { debugRest: true },
      contextEngine: { enableLLMSummary: true },
      summary: { cache: { backend: 'file', dir: '/tmp/s' } },
      session: { reset: { daily: true }, maintenance: { prune: true }, typo: 1 },
    };
    const detected = detectUnwiredConfigKeys(raw);
    for (const expected of [
      'compact',
      'models.mode',
      'knowledge.attachments.inject.recallTopK',
      'knowledge.attachments.inject.inventory',
      'knowledge.attachments.tools.attachmentsRootReadOnly',
      'knowledge.required',
      'contextEngine.enableLLMSummary',
      'summary.cache.backend',
      'summary.cache.dir',
      'plugins.configs',
      'gateway.debugRest',
      'session.reset',
      'session.maintenance',
      'session.typo',
    ]) {
      expect(detected, `missing unwired report: ${expected}`).toContain(expected);
    }
  });

  it('does not report consumed keys (no false positives)', () => {
    const raw = {
      gateway: { port: 8080, host: 'lan', hitlWebhook: { url: 'https://x.example/hook' } },
      session: { dmScope: 'per-peer', idleExpiryMs: 1000 },
      models: { providers: { p: {} }, embedding: { provider: 'p', model: 'e' }, level: { mini: { primary: 'p/m' } } },
      plugins: { loadPaths: ['./p'] },
      wisdom: {
        enabled: true,
        capacity: { hardCap: 80 },
        injection: { coreMaxItems: 5, scenarioMaxItems: 3, trialMaxItems: 2, trialVisible: true },
      },
      cognition: {
        enabled: true,
        identity: { mergeThreshold: 0.8, candidateBandHi: 0.9 },
        relations: { causesMinIndependentMemories: 2 },
        capacity: { stopNodes: 5000, stopEdges: 20000 },
      },
      memory: { retrieval: { minSimilarity: 0.35 } },
    };
    expect(detectUnwiredConfigKeys(raw)).toEqual([]);
  });

  it('reports block rules once even with many nested keys', () => {
    const raw = {
      compact: { defaultProtectHead: 1, defaultProtectTail: 2, defaultTargetTokens: 3 },
    };
    expect(detectUnwiredConfigKeys(raw)).toEqual(['compact']);
  });

  it('empty / non-object config reports nothing', () => {
    expect(detectUnwiredConfigKeys({})).toEqual([]);
    expect(detectUnwiredConfigKeys(null)).toEqual([]);
    expect(detectUnwiredConfigKeys('x')).toEqual([]);
  });

  it('init default config and canonical example carry no unwired keys (C4 regression)', async () => {
    const { generateDefaultConfig } = await import('../src/init.js');
    const { readFileSync } = await import('node:fs');
    const example = JSON.parse(
      readFileSync(new URL('../octopi.example.json', import.meta.url), 'utf-8'),
    );
    expect(detectUnwiredConfigKeys(generateDefaultConfig('/tmp/x'))).toEqual([]);
    expect(detectUnwiredConfigKeys(example)).toEqual([]);
  });
});
