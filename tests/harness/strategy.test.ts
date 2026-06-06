/**
 * StrategyRouter + ResourceManager 测试
 */

import { describe, it, expect } from 'vitest';
import {
  RuleTaskClassifier,
  DefaultStrategyRouter,
  ResourceManager,
} from '../../src/harness/index.js';

// ── RuleTaskClassifier 测试 ──

describe('RuleTaskClassifier', () => {
  const classifier = new RuleTaskClassifier();

  it('简单问题分类为 question + simple', async () => {
    const result = await classifier.classify('今天天气怎么样？');
    expect(result.category).toBe('question');
    expect(result.complexity).toBe('simple');
  });

  it('查询类分类为 lookup', async () => {
    const result = await classifier.classify('帮我搜索 TypeScript 泛型的用法');
    expect(result.category).toBe('lookup');
    expect(result.needsTools).toBe(true);
  });

  it('分析类分类为 analysis', async () => {
    const result = await classifier.classify('分析这段代码的性能问题');
    expect(result.category).toBe('analysis');
  });

  it('创作类分类为 creation', async () => {
    const result = await classifier.classify('帮我写一篇技术博客');
    expect(result.category).toBe('creation');
  });

  it('编码类分类为 coding', async () => {
    const result = await classifier.classify('帮我修复这个 bug');
    expect(result.category).toBe('coding');
  });

  it('规划类分类为 planning', async () => {
    const result = await classifier.classify('帮我规划一下这个项目的架构');
    expect(result.category).toBe('planning');
  });

  it('闲聊分类为 conversation', async () => {
    const result = await classifier.classify('你好');
    expect(result.category).toBe('conversation');
    expect(result.complexity).toBe('simple');
  });

  it('复杂任务需要规划', async () => {
    const result = await classifier.classify('帮我设计一个完整的电商系统架构，包括数据库、API、前端');
    expect(result.complexity).toBe('complex');
  });
});

// ── DefaultStrategyRouter 测试 ──

describe('DefaultStrategyRouter', () => {
  const router = new DefaultStrategyRouter();

  it('简单问题用 direct 策略', () => {
    const strategy = router.select({ category: 'question', complexity: 'simple', confidence: 0.8, needsTools: false, needsPlanning: false });
    expect(strategy.kind).toBe('direct');
  });

  it('查询用 tool_use 策略', () => {
    const strategy = router.select({ category: 'lookup', complexity: 'moderate', confidence: 0.7, needsTools: true, needsPlanning: false });
    expect(strategy.kind).toBe('tool_use');
  });

  it('分析用 chain_of_thought 策略', () => {
    const strategy = router.select({ category: 'analysis', complexity: 'moderate', confidence: 0.7, needsTools: false, needsPlanning: false });
    expect(strategy.kind).toBe('chain_of_thought');
  });

  it('规划用 plan_and_execute 策略', () => {
    const strategy = router.select({ category: 'planning', complexity: 'complex', confidence: 0.8, needsTools: false, needsPlanning: true });
    expect(strategy.kind).toBe('plan_and_execute');
  });

  it('复杂创作用 reflect 策略', () => {
    const strategy = router.select({ category: 'creation', complexity: 'complex', confidence: 0.8, needsTools: false, needsPlanning: false });
    expect(strategy.kind).toBe('reflect');
  });

  it('listStrategies 返回所有策略', () => {
    const strategies = router.listStrategies();
    expect(strategies.length).toBe(6);
  });
});

// ── ResourceManager 测试 ──

describe('ResourceManager', () => {
  describe('Token 预算', () => {
    it('正常请求允许通过', () => {
      const rm = new ResourceManager({ tokenBudget: { perCall: 1000 } });
      expect(rm.checkTokenBudget(500).allowed).toBe(true);
    });

    it('超过单次限制被拒绝', () => {
      const rm = new ResourceManager({ tokenBudget: { perCall: 1000 } });
      const result = rm.checkTokenBudget(2000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('per-call');
    });

    it('超过总预算被拒绝', () => {
      const rm = new ResourceManager({ tokenBudget: { total: 5000 } });
      rm.recordTokenUsage(3000, 0, 'gpt-4');
      const result = rm.checkTokenBudget(3000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('total');
    });
  });

  describe('速率限制', () => {
    it('正常请求允许通过', () => {
      const rm = new ResourceManager({ rateLimit: { requestsPerMinute: 10, maxConcurrent: 3 } });
      expect(rm.checkRateLimit().allowed).toBe(true);
    });

    it('并发超限被拒绝', () => {
      const rm = new ResourceManager({ rateLimit: { maxConcurrent: 2 } });
      rm.acquireRequest();
      rm.acquireRequest();
      const result = rm.checkRateLimit();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('concurrent');
    });

    it('release 后可以继续请求', () => {
      const rm = new ResourceManager({ rateLimit: { maxConcurrent: 1 } });
      rm.acquireRequest();
      expect(rm.checkRateLimit().allowed).toBe(false);
      rm.releaseRequest();
      expect(rm.checkRateLimit().allowed).toBe(true);
    });
  });

  describe('成本追踪', () => {
    it('记录成本', () => {
      const rm = new ResourceManager({
        pricing: { 'gpt-4': { inputPer1M: 30, outputPer1M: 60 } },
      });
      rm.recordTokenUsage(1000, 500, 'gpt-4');
      const stats = rm.stats();
      expect(stats.cost.total).toBeCloseTo(0.06); // 1000*30/1M + 500*60/1M = 0.03 + 0.03
    });

    it('按模型统计成本', () => {
      const rm = new ResourceManager({
        pricing: {
          'gpt-4': { inputPer1M: 30, outputPer1M: 60 },
          'gpt-3.5': { inputPer1M: 1, outputPer1M: 2 },
        },
      });
      rm.recordTokenUsage(1000, 0, 'gpt-4');
      rm.recordTokenUsage(1000, 0, 'gpt-3.5');
      const stats = rm.stats();
      expect(stats.cost.byModel['gpt-4']).toBeCloseTo(0.03);
      expect(stats.cost.byModel['gpt-3.5']).toBeCloseTo(0.001);
    });
  });

  describe('统计', () => {
    it('stats 返回完整统计', () => {
      const rm = new ResourceManager();
      rm.recordTokenUsage(100, 50, 'test');
      rm.acquireRequest();
      const stats = rm.stats();
      expect(stats.token.total).toBe(150);
      expect(stats.rate.concurrent).toBe(1);
    });
  });
});
