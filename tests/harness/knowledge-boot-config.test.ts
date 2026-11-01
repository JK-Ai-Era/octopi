/**
 * knowledgeTuningFromConfig / promotionThresholdsFromParams —
 * schema 形状（octopi.json knowledge.*）→ Service boot 调参块 / REST 阈值。
 *
 * 防回归背景：v0.60 拆独立 Knowledge Service 时这条传递线曾整体丢失，
 * 配了不生效（arch/config-key-audit-2026-11-01.md §1a/§2，v0.98.11 修复）。
 */
import { describe, it, expect } from 'vitest';
import { knowledgeTuningFromConfig } from '@octopi-agent/engine/harness/knowledge/boot-config.js';
import { promotionThresholdsFromParams } from '@octopi-agent/engine/harness/knowledge/http-params.js';
import { buildKnowledgeServiceBootFile } from '@octopi-agent/engine/harness/knowledge/start-service-process.js';

describe('knowledgeTuningFromConfig', () => {
  it('maps configured knowledge keys onto boot blocks', () => {
    const tuning = knowledgeTuningFromConfig({
      keywordWeight: 0.6,
      autoInject: { minScore: 0.8, minCoverage: 0.4, maxChunks: 6 },
      hint: { minScore: 0.55 },
      embed: {
        enabled: false,
        embedBatch: 16,
        embedMinIntervalMs: 500,
        embedConcurrency: 2,
        embedSecretPolicy: 'skip',
      },
      index: {
        hybridKeyword: false,
        queue: { maxDepth: 42 },
        files: { maxFileBytes: 100, parseTimeoutMs: 5000 },
      },
      load: { parseConcurrency: 3, debounceMs: 250, diskWatermarkAlert: true },
    });
    expect(tuning).toEqual({
      embed: {
        enabled: false,
        embedBatch: 16,
        embedMinIntervalMs: 500,
        embedConcurrency: 2,
        embedSecretPolicy: 'skip',
      },
      ingest: {
        parseConcurrency: 3,
        debounceMs: 250,
        maxQueueDepth: 42,
        diskWatermarkAlert: true,
        fileLimits: { maxFileBytes: 100, parseTimeoutMs: 5000 },
      },
      retriever: {
        hybridKeyword: false,
        keywordWeight: 0.6,
        injectMinScore: 0.8,
        hintMinScore: 0.55,
        minCoverage: 0.4,
      },
    });
  });

  it('omits unconfigured blocks so consumer defaults win', () => {
    expect(knowledgeTuningFromConfig(undefined)).toEqual({});
    expect(knowledgeTuningFromConfig(null)).toEqual({});
    // 同块部分配置：只输出显式键（grounding budget 键不进 boot——它们在 gateway 侧消费）
    expect(knowledgeTuningFromConfig({ autoInject: { maxChunks: 6, budgetTokens: 1200 } })).toEqual({});
  });
});

describe('buildKnowledgeServiceBootFile (hop lock)', () => {
  it('carries every tuning block into the Service boot file', () => {
    const tuning = knowledgeTuningFromConfig({
      keywordWeight: 0.6,
      index: { queue: { maxDepth: 42 }, files: { maxFileBytes: 100 } },
      load: { parseConcurrency: 3 },
      embed: { enabled: false, embedSecretPolicy: 'skip' },
      catalog: { autoDescribe: false },
    });
    const boot = buildKnowledgeServiceBootFile({
      dbPath: '/tmp/kn.db',
      tokens: [],
      ...tuning,
    });
    // 历史 bug 形态：hop 逐跳丢字段而编译不报错——这里锁住 Gateway→Service 的 boot 交接面
    expect(boot.dbPath).toBe('/tmp/kn.db');
    expect(boot.port).toBe(18280);
    expect(boot.embed).toEqual({ enabled: false, embedSecretPolicy: 'skip' });
    expect(boot.ingest).toEqual({
      parseConcurrency: 3,
      maxQueueDepth: 42,
      fileLimits: { maxFileBytes: 100 },
    });
    expect(boot.retriever).toEqual({ keywordWeight: 0.6 });
    expect(boot.autoDescribe).toBe(false);
  });
});

describe('promotionThresholdsFromParams', () => {
  it('parses valid thresholds', () => {
    expect(promotionThresholdsFromParams(new URLSearchParams('minSessions=5&minHits=20'))).toEqual({
      minSessions: 5,
      minHits: 20,
    });
  });

  it('drops missing/invalid values (hit-log defaults apply)', () => {
    expect(promotionThresholdsFromParams(new URLSearchParams())).toEqual({});
    expect(promotionThresholdsFromParams(new URLSearchParams('minSessions=-1&minHits=abc'))).toEqual({});
  });
});
