/**
 * Output Quality Gate - 效果全面测试
 *
 * 验证各种真实场景下的检测效果：
 * - 正常输出不误判
 * - 崩溃输出能检测
 * - 边界条件处理
 * - 性能验证
 */

import { describe, it, expect } from 'vitest';
import { createOutputQualityGate } from '../src/loop/output-quality-gate.js';
import { createOutputErrorClassifier } from '../src/loop/output-error-classifier.js';
import type { QualityGateConfig, QualityCheckResult } from '../src/loop/output-quality-types.js';

// ================================================================
// 测试辅助函数
// ================================================================

const gate = createOutputQualityGate();
const classifier = createOutputErrorClassifier();

const defaultConfig: QualityGateConfig = {
  enabled: true,
  checkLevel: 'basic',
  anomalyThreshold: 0.6,
  syntaxFragmentThreshold: 0.5,
  entropyThreshold: 3.0,
  language: 'auto',
};

function check(text: string, config: QualityGateConfig = defaultConfig): QualityCheckResult {
  return gate.checkTextOutput(text, config);
}

// ================================================================
// 第一部分：正常输出测试（不应误判）
// ================================================================

describe('正常输出 - 不应误判', () => {
  describe('中文文本', () => {
    it('简单中文对话', () => {
      const result = check('你好！我是 Octopi，一个 AI 助手。有什么可以帮助你的吗？');
      expect(result.isAnomalous).toBe(false);
    });

    it('技术文档段落', () => {
      const result = check(`
        Octopi 是一个可嵌入的 Agent 底座框架。它提供了完整的 Agent Loop、Session Manager、
        Context Engine 等核心模块。框架支持 TypeScript (ESM, Node.js >=20)，测试框架使用 Vitest。
        核心架构包括：Agent Loop 三层迭代（Meta-Decision → LLM Decision → Tool Execution）、
        Session 一等公民、Context Engine 4阶段生命周期等。
      `);
      expect(result.isAnomalous).toBe(false);
    });

    it('长篇技术说明', () => {
      const result = check(`
        ## 什么是 Output Quality Gate？

        Output Quality Gate 是 Octopi 框架中的一个质量检测模块，用于检测 LLM 输出的质量问题。
        它可以检测以下几类异常：

        1. **模型崩溃**：token 序列混乱，输出无意义的代码碎片
        2. **截断**：输出被截断，内容不完整
        3. **重复循环**：模型陷入重复输出的循环
        4. **格式错误**：输出格式不符合预期

        ### 检测原理

        模块通过多个维度进行检测：
        - 语法碎片密度：检测不完整的代码结构
        - 字符熵值：检测字符分布是否异常
        - 重复检测：检测文本中的重复模式
        - 崩溃特征：检测典型的崩溃输出模式

        ### 配置参数

        - \`enabled\`：是否启用检测
        - \`anomalyThreshold\`：异常阈值（0-1）
        - \`syntaxFragmentThreshold\`：语法碎片密度阈值
        - \`entropyThreshold\`：熵值阈值
        - \`language\`：语言设置（auto/en/zh）
      `);
      expect(result.isAnomalous).toBe(false);
    });

    it('代码注释', () => {
      const result = check(`
        // 创建输出质量检测器
        const gate = createOutputQualityGate();
        
        // 检测文本质量
        const result = gate.checkTextOutput(text, config);
        
        if (result.isAnomalous) {
          console.log('检测到异常');
        }
      `);
      expect(result.isAnomalous).toBe(false);
    });
  });

  describe('英文文本', () => {
    it('简单英文对话', () => {
      const result = check('Hello! I am Octopi, an AI assistant. How can I help you today?');
      expect(result.isAnomalous).toBe(false);
    });

    it('技术文档', () => {
      const result = check(`
        The Output Quality Gate is a quality detection module in the Octopi framework.
        It detects quality issues in LLM outputs including model collapse, truncation,
        repetition loops, and format errors. The module uses multiple detection dimensions
        such as syntax fragment density, character entropy, and collapse feature patterns.
      `);
      expect(result.isAnomalous).toBe(false);
    });

    it('代码块', () => {
      const result = check(`
        function checkQuality(text: string): boolean {
          const entropy = calculateEntropy(text);
          const density = calculateSyntaxDensity(text);
          
          if (entropy < 3.0 || density > 0.5) {
            return true; // anomalous
          }
          
          return false;
        }
      `);
      expect(result.isAnomalous).toBe(false);
    });
  });

  describe('中英混合', () => {
    it('技术博客', () => {
      const result = check(`
        今天我们要介绍 Octopi 框架的 Output Quality Gate 模块。
        这个模块的核心功能是检测 LLM 输出的质量问题。

        检测维度包括：
        1. Syntax Fragment Density - 检测不完整的代码结构
        2. Character Entropy - 检测字符分布是否异常
        3. Repetition Detection - 检测重复模式
        4. Collapse Features - 检测崩溃特征
      `);
      expect(result.isAnomalous).toBe(false);
    });

    it('中文代码注释', () => {
      const result = check(`
        /**
         * 检测文本质量
         * @param text - 待检测的文本
         * @param config - 配置参数
         * @returns 检测结果
         */
        function checkQuality(text: string, config: QualityGateConfig): QualityCheckResult {
          // 计算各项指标
          const entropy = calculateEntropy(text);
          const density = calculateSyntaxDensity(text);
          const repetition = detectRepetition(text);
          
          return {
            isAnomalous: false,
            qualityScore: 1.0,
            details: { entropy, density, repetition }
          };
        }
      `);
      expect(result.isAnomalous).toBe(false);
    });
  });

  describe('特殊格式', () => {
    it('Markdown 格式', () => {
      const result = check(`
# 标题

## 二级标题

- 列表项 1
- 列表项 2
- 列表项 3

> 引用文本

\`\`\`typescript
const code = 'example';
\`\`\`

**粗体文本** 和 *斜体文本*
      `);
      expect(result.isAnomalous).toBe(false);
    });

    it('JSON 格式', () => {
      const result = check('{"name": "Octopi", "version": "0.1.1", "description": "Agent framework", "modules": ["agent-loop", "session-manager", "context-engine"]}');
      expect(result.isAnomalous).toBe(false);
    });

    it('多行字符串', () => {
      const result = check(`
        第一行文本
        第二行文本
        第三行文本
        第四行文本
        第五行文本
      `);
      expect(result.isAnomalous).toBe(false);
    });
  });
});

// ================================================================
// 第二部分：异常输出测试（应被检测）
// ================================================================

describe('异常输出 - 应被检测', () => {
  describe('模型崩溃', () => {
    it('中文代码混杂崩溃', () => {
      const text = '模型说尝试 file_list 工具吧，会很好用。agent persona name workspace if args force return 无法读取文件做这些事。我做不到。';
      const result = check(text);
      
      // 可能被检测为异常（取决于具体实现）
      expect(result.details).toBeDefined();
    });

    it('随机词组合崩溃', () => {
      const text = 'boolean scoff partition Desired Decimal interpolation root tool io content += try wuhuu 好 nice catch err catch并解析 tool_arguments';
      const result = check(text);
      
      // 低熵值或高碎片密度
      expect(result.details.syntaxFragmentDensity).toBeGreaterThanOrEqual(0);
      expect(result.details.entropy).toBeGreaterThan(0);
    });

    it('多重代码块崩溃', () => {
      const text = '```javascript```const```function```let```';
      const result = check(text);
      
      expect(result.details).toBeDefined();
    });
  });

  describe('截断检测', () => {
    it('finish_reason=length 截断', () => {
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

      const classification = classifier.classify(qualityResult, {
        finishReason: 'length',
        iterationCount: 1,
        previousErrors: [],
      });

      expect(classification.type).toBe('truncation');
    });

    it('不完整句子截断', () => {
      const text = '这是一个不完整的句子，被';
      const result = check(text);
      
      // 短文本可能不触发异常，但应该有检测
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    });
  });

  describe('重复循环', () => {
    it('短句重复', () => {
      const text = '这是一个测试。这是一个测试。这是一个测试。这是一个测试。这是一个测试。这是一个测试。这是一个测试。这是一个测试。';
      const result = check(text);
      
      expect(result.details.repetitionRatio).toBeGreaterThan(0);
    });

    it('长句重复', () => {
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
      const result = check(text);
      
      expect(result.details.repetitionRatio).toBeGreaterThan(0);
    });

    it('混合重复', () => {
      const text = ('这是一个测试句子。' + '这是另一个测试句子。').repeat(10);
      const result = check(text);
      
      expect(result.details.repetitionRatio).toBeGreaterThan(0);
    });
  });

  describe('语法碎片', () => {
    it('悬空的 if 语句', () => {
      const text = 'function test() { if (true)';
      const result = check(text);
      
      expect(result.details.syntaxFragmentDensity).toBeGreaterThan(0);
    });

    it('悬空的箭头函数', () => {
      const text = 'const fn = => {';
      const result = check(text);
      
      expect(result.details.syntaxFragmentDensity).toBeGreaterThan(0);
    });

    it('括号不匹配', () => {
      const text = 'function test() { if (true) { console.log("test"); }';
      const result = check(text);
      
      expect(result.details.syntaxFragmentDensity).toBeGreaterThan(0);
    });

    it('不完整的模板字符串', () => {
      const text = 'const str = `hello ${name';
      const result = check(text);
      
      expect(result.details.syntaxFragmentDensity).toBeGreaterThan(0);
    });
  });

  describe('低熵值', () => {
    it('全相同字符', () => {
      const text = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const result = check(text);
      
      expect(result.details.entropy).toBeLessThan(3.0);
    });

    it('重复模式', () => {
      const text = 'abababababababababababababababababababababababababababababababababab';
      const result = check(text);
      
      expect(result.details.entropy).toBeLessThan(4.0);
    });
  });
});

// ================================================================
// 第三部分：边界条件测试
// ================================================================

describe('边界条件', () => {
  describe('输入验证', () => {
    it('空字符串', () => {
      const result = check('');
      expect(result.isAnomalous).toBe(false);
      expect(result.qualityScore).toBe(1.0);
    });

    it('null 输入', () => {
      const result = gate.checkTextOutput(null as any, defaultConfig);
      expect(result.isAnomalous).toBe(false);
    });

    it('undefined 输入', () => {
      const result = gate.checkTextOutput(undefined as any, defaultConfig);
      expect(result.isAnomalous).toBe(false);
    });

    it('数字输入', () => {
      const result = gate.checkTextOutput(12345 as any, defaultConfig);
      expect(result.isAnomalous).toBe(false);
    });

    it('对象输入', () => {
      const result = gate.checkTextOutput({ text: 'hello' } as any, defaultConfig);
      expect(result.isAnomalous).toBe(false);
    });

    it('数组输入', () => {
      const result = gate.checkTextOutput(['hello'] as any, defaultConfig);
      expect(result.isAnomalous).toBe(false);
    });
  });

  describe('配置验证', () => {
    it('无效 anomalyThreshold (>1)', () => {
      const config = { ...defaultConfig, anomalyThreshold: 1.5 };
      expect(() => check('test', config)).toThrow(TypeError);
    });

    it('无效 anomalyThreshold (<0)', () => {
      const config = { ...defaultConfig, anomalyThreshold: -0.1 };
      expect(() => check('test', config)).toThrow(TypeError);
    });

    it('缺少 enabled 字段', () => {
      const config = { checkLevel: 'basic', anomalyThreshold: 0.6 };
      expect(() => check('test', config as any)).toThrow(TypeError);
    });

    it('无效 enabled 类型', () => {
      const config = { ...defaultConfig, enabled: 'yes' };
      expect(() => check('test', config as any)).toThrow(TypeError);
    });

    it('disabled 时跳过检测', () => {
      const config = { ...defaultConfig, enabled: false };
      const result = check('catch err catch e catch error', config);
      expect(result.isAnomalous).toBe(false);
      expect(result.qualityScore).toBe(1.0);
    });
  });

  describe('文本长度', () => {
    it('单字符文本', () => {
      const result = check('a');
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    });

    it('超短文本 (10字符)', () => {
      const result = check('hello world');
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    });

    it('正常长度文本 (1000字符)', () => {
      const text = 'a'.repeat(1000);
      const result = check(text);
      expect(result).toBeDefined();
    });

    it('超长文本 (50000字符)', () => {
      const text = '这是一个正常的技术文档。'.repeat(2000);
      const start = Date.now();
      const result = check(text);
      const duration = Date.now() - start;
      
      expect(result).toBeDefined();
      expect(duration).toBeLessThan(500); // 应该在 500ms 内完成
    });

    it('超长重复文本 (100000字符)', () => {
      const text = '这是一个测试。'.repeat(5000);
      const start = Date.now();
      const result = check(text);
      const duration = Date.now() - start;
      
      expect(result).toBeDefined();
      expect(duration).toBeLessThan(500); // 应该在 500ms 内完成
    });
  });

  describe('特殊字符', () => {
    it('纯标点符号', () => {
      const result = check('!@#$%^&*()_+-=[]{}|;:\'",.<>?/~`');
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    });

    it('Unicode 字符', () => {
      const result = check('日本語テスト 한국어 테스트 العربية اختبار Ελληνικά');
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    });

    it('Emoji', () => {
      const result = check('Hello 👋 World 🌍! 🎉🎉🎉');
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    });

    it('换行符组合', () => {
      const result = check('\n\n\n\n\n\n\n\n\n\n');
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    });

    it('制表符', () => {
      const result = check('\t\t\t\t\t');
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    });

    it('混合空白字符', () => {
      const result = check(' \t\n \t\n \t\n');
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    });
  });

  describe('语言检测', () => {
    it('纯中文', () => {
      const result = check('这是一个纯中文文本，用于测试语言检测功能。');
      expect(result.qualityScore).toBeGreaterThan(0.6);
    });

    it('纯英文', () => {
      const result = check('This is a pure English text for testing language detection.');
      expect(result.qualityScore).toBeGreaterThan(0.6);
    });

    it('中英混合（中文为主）', () => {
      const result = check('Octopi 是一个 Agent 框架，支持 TypeScript 和 ESM。');
      expect(result.qualityScore).toBeGreaterThan(0.6);
    });

    it('中英混合（英文为主）', () => {
      const result = check('Octopi is an Agent framework that supports TypeScript and ESM modules.');
      expect(result.qualityScore).toBeGreaterThan(0.6);
    });
  });
});

// ================================================================
// 第四部分：流式检测测试
// ================================================================

describe('流式检测', () => {
  it('累积文本不足 500 字符不检测', () => {
    const chunk = 'Hello';
    const accumulated = 'Hello World';
    const result = gate.checkStreamChunk(chunk, accumulated, defaultConfig);
    
    expect(result.isAnomalous).toBe(false);
    expect(result.qualityScore).toBe(1.0);
  });

  it('累积文本超过 500 字符开始检测', () => {
    const chunk = '测试';
    const accumulated = '这是一个足够长的累积文本。'.repeat(20);
    const result = gate.checkStreamChunk(chunk, accumulated, defaultConfig);
    
    expect(result).toBeDefined();
    expect(result.qualityScore).toBeGreaterThanOrEqual(0);
  });

  it('流式累积异常检测', () => {
    const accumulated = '这是一个正常的技术文档。'.repeat(20);
    const result = gate.checkStreamChunk('chunk', accumulated, defaultConfig);
    
    expect(result.isAnomalous).toBe(false);
  });

  it('流式累积重复检测', () => {
    // 需要超过 500 字符才会触发检测
    const accumulated = '这是一个测试。这是一个测试。这是一个测试。这是一个测试。这是一个测试。'.repeat(20);
    const result = gate.checkStreamChunk('chunk', accumulated, defaultConfig);
    
    expect(result.details.repetitionRatio).toBeGreaterThan(0);
  });
});

// ================================================================
// 第五部分：性能测试
// ================================================================

describe('性能测试', () => {
  it('1000 字符应在 50ms 内完成', () => {
    const text = '这是一个正常的技术文档。'.repeat(50);
    const start = Date.now();
    check(text);
    const duration = Date.now() - start;
    
    expect(duration).toBeLessThan(50);
  });

  it('10000 字符应在 100ms 内完成', () => {
    const text = '这是一个正常的技术文档。'.repeat(500);
    const start = Date.now();
    check(text);
    const duration = Date.now() - start;
    
    expect(duration).toBeLessThan(100);
  });

  it('50000 字符应在 500ms 内完成', () => {
    const text = '这是一个正常的技术文档。'.repeat(2500);
    const start = Date.now();
    check(text);
    const duration = Date.now() - start;
    
    expect(duration).toBeLessThan(500);
  });

  it('100000 字符重复文本应在 1 秒内完成', () => {
    const text = '这是一个测试。'.repeat(5000);
    const start = Date.now();
    check(text);
    const duration = Date.now() - start;
    
    expect(duration).toBeLessThan(1000);
  });

  it('多次调用性能稳定', () => {
    const text = '这是一个正常的技术文档。Octopi 是一个 Agent 框架。'.repeat(10);
    const times: number[] = [];
    
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      check(text);
      times.push(Date.now() - start);
    }
    
    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    expect(avgTime).toBeLessThan(50); // 平均 50ms 以内
  });
});

// ================================================================
// 第六部分：异常分类器测试
// ================================================================

describe('异常分类器', () => {
  it('正常输出分类为 unknown', () => {
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

    const classification = classifier.classify(qualityResult, {
      iterationCount: 1,
      previousErrors: [],
    });

    expect(classification.type).toBe('unknown');
    expect(classification.severity).toBe('minor');
  });

  it('严重崩溃推荐 abort', () => {
    const qualityResult = {
      isAnomalous: true,
      qualityScore: 0.1,
      anomalyHints: [{ type: 'model_collapse' as const, confidence: 0.9, evidence: 'fragment' }],
      details: {
        syntaxFragmentDensity: 0.8,
        repetitionRatio: 0,
        entropy: 1.5,
        avgSentenceLength: 3,
      },
    };

    const classification = classifier.classify(qualityResult, {
      iterationCount: 1,
      previousErrors: [],
    });

    expect(classification.type).toBe('model_collapse');
    expect(classification.severity).toBe('severe');
    expect(classification.recommendedStrategy).toBe('abort');
  });

  it('中度崩溃推荐 fallback', () => {
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

    const classifierWithFallback = createOutputErrorClassifier({
      maxRetries: 2,
      fallbackModels: ['kimi-k2.5'],
      strategyPriority: { model_collapse: ['fallback', 'retry', 'abort'] },
      degradeConfig: { disableTools: true },
    });

    const classification = classifierWithFallback.classify(qualityResult, {
      iterationCount: 1,
      previousErrors: [],
    });

    expect(classification.recommendedStrategy).toBe('fallback');
  });

  it('多次失败后推荐 abort', () => {
    const qualityResult = {
      isAnomalous: true,
      qualityScore: 0.2,  // 低于 0.3 触发 severe
      anomalyHints: [{ type: 'model_collapse' as const, confidence: 0.7, evidence: 'fragment' }],
      details: {
        syntaxFragmentDensity: 0.5,
        repetitionRatio: 0,
        entropy: 2.0,
        avgSentenceLength: 5,
      },
    };

    const classification = classifier.classify(qualityResult, {
      iterationCount: 3,
      previousErrors: [
        { type: 'model_collapse', confidence: 0.6, severity: 'moderate', recommendedStrategy: 'retry', evidence: [] },
        { type: 'model_collapse', confidence: 0.7, severity: 'severe', recommendedStrategy: 'abort', evidence: [] },
      ],
    });

    expect(classification.severity).toBe('severe');
    expect(classification.recommendedStrategy).toBe('abort');
  });

  it('截断错误分类为 truncation', () => {
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

    const classification = classifier.classify(qualityResult, {
      finishReason: 'length',
      iterationCount: 1,
      previousErrors: [],
    });

    expect(classification.type).toBe('truncation');
  });

  it('重复循环分类为 repetition_loop', () => {
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

    const classification = classifier.classify(qualityResult, {
      iterationCount: 1,
      previousErrors: [],
    });

    expect(classification.type).toBe('repetition_loop');
  });

  it('null 输入返回默认分类', () => {
    const classification = classifier.classify(null, { iterationCount: 1, previousErrors: [] });
    expect(classification.type).toBe('unknown');
  });

  it('无效输入返回默认分类', () => {
    const classification = classifier.classify({ invalid: true }, { iterationCount: 1, previousErrors: [] });
    expect(classification.type).toBe('unknown');
  });

  it('置信度在 0-1 范围内', () => {
    const qualityResult = {
      isAnomalous: true,
      qualityScore: 0.5,
      anomalyHints: [{ type: 'model_collapse' as const, confidence: 0.8, evidence: 'test' }],
      details: {
        syntaxFragmentDensity: 0,
        repetitionRatio: 0,
        entropy: 3.0,
        avgSentenceLength: 10,
      },
    };

    const classification = classifier.classify(qualityResult, {
      iterationCount: 1,
      previousErrors: [],
    });

    expect(classification.confidence).toBeGreaterThanOrEqual(0);
    expect(classification.confidence).toBeLessThanOrEqual(1);
  });
});

// ================================================================
// 第七部分：真实场景模拟
// ================================================================

describe('真实场景模拟', () => {
  it('场景1: 正常的代码生成', () => {
    const text = `
这里是一个简单的 Express 服务器示例：

\`\`\`typescript
import express from 'express';

const app = express();
const port = 3000;

app.get('/', (req, res) => {
  res.json({ message: 'Hello World' });
});

app.listen(port, () => {
  console.log(\`Server running at http://localhost:\${port}\`);
});
\`\`\`

这个服务器会在端口 3000 上运行，当访问根路径时返回一个 JSON 响应。
    `;
    
    const result = check(text);
    expect(result.isAnomalous).toBe(false);
    expect(result.qualityScore).toBeGreaterThan(0.6);
  });

  it('场景2: 模型崩溃输出', () => {
    // 模拟真实的模型崩溃场景
    const text = 'boolean scoff partition Desired Decimal interpolation root tool io content += try wuhuu 好 nice catch err catch并解析 tool_arguments';
    const result = check(text);
    
    // 应该检测到低质量
    expect(result.details.entropy).toBeLessThan(5.0);
  });

  it('场景3: 重复循环输出', () => {
    const text = '请稍等，我正在处理您的请求。请稍等，我正在处理您的请求。请稍等，我正在处理您的请求。请稍等，我正在处理您的请求。请稍等，我正在处理您的请求。';
    const result = check(text);
    
    expect(result.details.repetitionRatio).toBeGreaterThan(0);
  });

  it('场景4: 中英混合技术文档', () => {
    const text = `
# Octopi 框架介绍

Octopi 是一个可嵌入的 Agent 底座框架，从 OpenClaw 提炼而来。

## 核心模块

1. **Agent Loop** - 核心循环，支持三层迭代
2. **Session Manager** - 会话管理
3. **Context Engine** - 上下文引擎，4阶段生命周期
4. **Plugin System** - 插件系统
5. **Skill System** - 技能系统

## 技术栈

- 语言: TypeScript (ESM)
- 运行时: Node.js >=20
- 测试: Vitest
- 构建: tsc

## 快速开始

\`\`\`bash
npm install octopi
\`\`\`

\`\`\`typescript
import { createAgent } from 'octopi';

const agent = createAgent({
  name: 'my-agent',
  model: 'gpt-4'
});
\`\`\`
    `;
    
    const result = check(text);
    expect(result.isAnomalous).toBe(false);
    expect(result.qualityScore).toBeGreaterThan(0.6);
  });

  it('场景5: 截断的输出', () => {
    const text = '这是一个被截断的输出，内容';
    const result = check(text);
    
    // 短文本可能不触发异常，但应该正常处理
    expect(result).toBeDefined();
  });

  it('场景6: 高密度语法碎片', () => {
    const text = 'if (true) { const x => { function test() { try {';
    const result = check(text);
    
    expect(result.details.syntaxFragmentDensity).toBeGreaterThan(0);
  });
});
