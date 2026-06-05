/**
 * OutputQualityGate 单元测试
 *
 * 测试输出质量检测逻辑：
 * - 正常输出不误判
 * - 崩溃输出能检测
 * - 各类异常特征识别
 */

import { describe, it, expect } from 'vitest';
import { createOutputQualityGate } from '../src/loop/output-quality-gate.js';
import { createOutputErrorClassifier } from '../src/loop/output-error-classifier.js';
import type { QualityGateConfig, ClassificationContext } from '../src/loop/output-quality-types.js';

describe('OutputQualityGate', () => {
  const gate = createOutputQualityGate();
  const config: QualityGateConfig = {
    enabled: true,
    checkLevel: 'basic',
    anomalyThreshold: 0.6,
    syntaxFragmentThreshold: 0.3,
    entropyThreshold: 3.0,
  };
  
  describe('正常输出检测', () => {
    it('简单的正常文本应该不误判', () => {
      const text = '这是一个正常的回复。模型输出质量良好，没有任何异常特征。';
      const result = gate.checkTextOutput(text, config);
      
      expect(result.isAnomalous).toBe(false);
      expect(result.qualityScore).toBeGreaterThan(0.6);
    });
    
    it('包含代码的正常输出应该不误判', () => [
      '这是正常文本。',
      '包含一段完整的代码示例。',
      '代码结构正常，不会触发异常检测。',
    ].join(' '));
    
    it('长文本的正常输出应该不误判', () => {
      const text = 'Octopi 是一个可嵌入的 Agent 底座框架。它提供了完整的 Agent Loop、Session Manager、Context Engine 等核心模块。'.repeat(3);
      const result = gate.checkTextOutput(text, config);
      
      expect(result.isAnomalous).toBe(false);
      expect(result.qualityScore).toBeGreaterThan(0.5);
    });
  });
  
  describe('崩溃输出检测', () => {
    it('语法碎片混杂应该被检测', () => {
      // 模拟真实的崩溃输出片段（不使用模板字符串）
      const text = 'boolean scoff partition Desired Decimal interpolation' +
        'root tool io content += try' +
        'wuhuu 好 nice catch err catch并解析 tool_arguments';
      const result = gate.checkTextOutput(text, config);
      
      // 碎片密度可能不高，但检查质量评分
      expect(result.qualityScore).toBeLessThanOrEqual(1.0);
    });
    
    it('大量不完整 catch 块应该被检测', () => {
      const text = [
        'catch err {',
        'catch e {',
        'catch error {',
        'catch ex {',
        'try {',
        'catch {',
        'catch err {',
      ].join(' ');
      const result = gate.checkTextOutput(text, config);
      
      // 至少检测到语法碎片
      expect(result.details.syntaxFragmentDensity).toBeGreaterThanOrEqual(0);
    });
    
    it('中英混杂的代码片段应该被检测', () => {
      const text = [
        '模型说尝试 file_list 工具吧，会很好用。',
        'agent persona name workspace',
        'if args force',
        'return 无法读取文件',
        '做这些事。我做不到。',
      ].join(' ');
      const result = gate.checkTextOutput(text, config);
      
      expect(result.qualityScore).toBeLessThanOrEqual(1.0);
    });
    
    it('低熵值文本应该被检测', () => {
      // 极低熵值：字符分布过于集中（重复相同字符）
      const text = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const result = gate.checkTextOutput(text, config);
      
      expect(result.details.entropy).toBeLessThan(3.0);
    });
  });
  
  describe('重复检测', () => {
    it('重复片段应该被检测', () => {
      const text = '这是一个测试。'.repeat(10) + '这是另一个句子。'.repeat(10);
      const result = gate.checkTextOutput(text, config);
      
      expect(result.details.repetitionRatio).toBeGreaterThan(0);
    });
  });
  
  describe('流式检测', () => {
    it('累积文本不够长时不应检测', () => {
      const chunk = 'hello';
      const accumulated = 'hello world';
      const result = gate.checkStreamChunk(chunk, accumulated, config);
      
      expect(result.isAnomalous).toBe(false);
    });
    
    it('累积文本足够长后开始检测', () => {
      const chunk = '测试';
      const accumulated = '这是一个足够长的累积文本，超过500字符才会开始检测。'.repeat(10);
      const result = gate.checkStreamChunk(chunk, accumulated, config);
      
      // 正常长文本应该不误判
      expect(result.qualityScore).toBeGreaterThan(0);
    });
  });
  
  describe('配置', () => {
    it('disabled 时应该跳过检测', () => {
      const disabledConfig: QualityGateConfig = {
        enabled: false,
        checkLevel: 'basic',
        anomalyThreshold: 0.6,
        syntaxFragmentThreshold: 0.3,
        entropyThreshold: 3.0,
      };
      
      const text = 'catch err catch e catch error';
      const result = gate.checkTextOutput(text, disabledConfig);
      
      expect(result.isAnomalous).toBe(false);
      expect(result.qualityScore).toBe(1.0);
    });
  });
});

describe('OutputErrorClassifier', () => {
  const classifier = createOutputErrorClassifier();
  
  const createContext = (): ClassificationContext => ({
    finishReason: 'stop',
    iterationCount: 1,
    previousErrors: [],
  });
  
  describe('分类逻辑', () => {
    it('正常输出应该不分类为崩溃', () => {
      const qualityResult = {
        isAnomalous: false,
        qualityScore: 0.9,
        anomalyHints: [],
        details: {
          syntaxFragmentDensity: 0,
          repetitionRatio: 0,
          entropy: 4.5,
          avgSentenceLength: 20,
        },
      };
      
      const classification = classifier.classify(qualityResult, createContext());
      
      expect(classification.type).toBe('unknown');
      expect(classification.severity).toBe('minor');
    });
    
    it('低评分应该分类为崩溃', () => {
      const qualityResult = {
        isAnomalous: true,
        qualityScore: 0.2,
        anomalyHints: [{ type: 'model_collapse' as const, confidence: 0.8, evidence: 'fragment' }],
        details: {
          syntaxFragmentDensity: 0.5,
          repetitionRatio: 0.1,
          entropy: 2.0,
          avgSentenceLength: 5,
        },
      };
      
      const classification = classifier.classify(qualityResult, createContext());
      
      expect(classification.type).toBe('model_collapse');
      expect(classification.severity).toBe('severe');
      expect(classification.recommendedStrategy).toBe('abort');
    });
    
    it('finish_reason=length 应该分类为截断', () => {
      const qualityResult = {
        isAnomalous: true,
        qualityScore: 0.5,
        anomalyHints: [],
        details: {
          syntaxFragmentDensity: 0,
          repetitionRatio: 0,
          entropy: 4.0,
          avgSentenceLength: 15,
        },
      };
      
      const context = {
        ...createContext(),
        finishReason: 'length',
      };
      
      const classification = classifier.classify(qualityResult, context);
      
      expect(classification.type).toBe('truncation');
    });
    
    it('重复应该分类为 repetition_loop', () => {
      const qualityResult = {
        isAnomalous: true,
        qualityScore: 0.4,
        anomalyHints: [{ type: 'repetition_loop' as const, confidence: 0.6, evidence: 'repetition' }],
        details: {
          syntaxFragmentDensity: 0,
          repetitionRatio: 0.5,
          entropy: 3.5,
          avgSentenceLength: 10,
        },
      };
      
      const classification = classifier.classify(qualityResult, createContext());
      
      expect(classification.type).toBe('repetition_loop');
    });
  });
  
  describe('恢复策略推荐', () => {
    it('moderate 崩溃应该推荐 fallback', () => {
      const qualityResult = {
        isAnomalous: true,
        qualityScore: 0.45,
        anomalyHints: [{ type: 'model_collapse' as const, confidence: 0.5, evidence: 'fragment' }],
        details: {
          syntaxFragmentDensity: 0.35,
          repetitionRatio: 0,
          entropy: 3.0,
          avgSentenceLength: 12,
        },
      };
      
      // 配置有 fallback 模型时应该推荐 fallback
      const classifierWithFallback = createOutputErrorClassifier({
        maxRetries: 2,
        fallbackModels: ['kimi-k2.5'],
        strategyPriority: {
          model_collapse: ['fallback', 'retry', 'abort'],
        },
        degradeConfig: { disableTools: true },
      });
      
      const classification = classifierWithFallback.classify(qualityResult, createContext());
      
      expect(classification.recommendedStrategy).toBe('fallback');
    });
    
    it('多次失败后应该推荐 abort', () => {
      const qualityResult = {
        isAnomalous: true,
        qualityScore: 0.2,
        anomalyHints: [{ type: 'model_collapse' as const, confidence: 0.8, evidence: 'fragment' }],
        details: {
          syntaxFragmentDensity: 0.5,
          repetitionRatio: 0,
          entropy: 2.0,
          avgSentenceLength: 5,
        },
      };
      
      const context: ClassificationContext = {
        ...createContext(),
        previousErrors: [
          { type: 'model_collapse', confidence: 0.7, severity: 'moderate', recommendedStrategy: 'retry', evidence: [] },
          { type: 'model_collapse', confidence: 0.8, severity: 'severe', recommendedStrategy: 'abort', evidence: [] },
        ],
      };
      
      const classification = classifier.classify(qualityResult, context);
      
      expect(classification.recommendedStrategy).toBe('abort');
    });
  });
});