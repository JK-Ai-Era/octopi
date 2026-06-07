/**
 * Scenario Composer — 场景组合与参数化
 *
 * 支持：
 * - 场景片段（ScenarioFragment）复用
 * - 组合多个片段为完整场景
 * - 参数化运行（同一场景 × 不同参数）
 * - 场景继承（基础场景 + 扩展断言）
 */

import type { Scenario, ScenarioAssertion, ScenarioResult } from './scenario-runner.js';
import { ScenarioRunner, formatScenarioResult } from './scenario-runner.js';
import type { ScenarioRunnerConfig } from './scenario-runner.js';

// ── 场景片段 ──

/**
 * ScenarioFragment — 可复用的场景片段
 *
 * 消息模板支持 {variable} 占位符，运行时替换。
 */
export interface ScenarioFragment {
  /** 片段名称 */
  name?: string;
  /** 消息列表（支持 {var} 占位符） */
  messages: string[];
  /** 每条消息的断言 */
  assertions?: ScenarioAssertion[][];
  /** 运行配置 */
  config?: Scenario['config'];
}

// ── 组合函数 ──

/**
 * 组合多个片段为一个完整场景
 *
 * @param name - 场景名称
 * @param fragments - 片段列表
 * @param params - 模板参数（可选，单组参数时直接替换）
 * @returns 完整场景
 */
export function compose(
  name: string,
  fragments: ScenarioFragment[],
  params?: Record<string, string>,
): Scenario {
  const allMessages: string[] = [];
  const allAssertions: ScenarioAssertion[][] = [];

  for (const fragment of fragments) {
    for (let i = 0; i < fragment.messages.length; i++) {
      let msg = fragment.messages[i];
      // 始终应用模板（{random} 等内置变量始终生效）
      msg = applyTemplate(msg, params ?? {});
      allMessages.push(msg);

      if (fragment.assertions?.[i]) {
        allAssertions.push(fragment.assertions[i]);
      }
    }
  }

  return {
    name,
    messages: allMessages,
    assertions: allAssertions.length > 0 ? allAssertions : undefined,
  };
}

/**
 * 组合场景并继承/扩展断言
 *
 * 在基础场景的断言之上追加额外断言。
 */
export function extendScenario(
  base: Scenario,
  extensions: {
    /** 追加的断言（按 turn 索引） */
    assertions?: Record<number, ScenarioAssertion[]>;
    /** 额外的消息 */
    extraMessages?: string[];
    /** 额外消息的断言 */
    extraAssertions?: ScenarioAssertion[][];
    /** 覆盖配置 */
    config?: Scenario['config'];
  },
): Scenario {
  const messages = [...base.messages, ...(extensions.extraMessages ?? [])];
  const assertions: ScenarioAssertion[][] = [];

  // 复制基础断言
  if (base.assertions) {
    for (let i = 0; i < base.assertions.length; i++) {
      assertions.push([...base.assertions[i]]);
    }
  }

  // 追加扩展断言
  if (extensions.assertions) {
    for (const [turnIdx, newAssertions] of Object.entries(extensions.assertions)) {
      const idx = parseInt(turnIdx);
      if (!assertions[idx]) assertions[idx] = [];
      assertions[idx].push(...newAssertions);
    }
  }

  // 追加额外消息的断言
  if (extensions.extraAssertions) {
    assertions.push(...extensions.extraAssertions);
  }

  return {
    name: base.name,
    messages,
    assertions: assertions.length > 0 ? assertions : undefined,
    config: extensions.config ?? base.config,
  };
}

// ── 参数化运行 ──

export interface ParameterizedResult {
  /** 参数组 */
  params: Record<string, string>;
  /** 场景结果 */
  result: ScenarioResult;
}

/**
 * 参数化运行同一场景
 *
 * @param fragment - 场景片段（含 {var} 占位符）
 * @param paramSets - 参数组列表
 * @param config - 运行配置
 * @returns 每组参数的运行结果
 */
export async function runParameterized(
  fragment: ScenarioFragment,
  paramSets: Record<string, string>[],
  config: ScenarioRunnerConfig,
): Promise<ParameterizedResult[]> {
  const results: ParameterizedResult[] = [];

  for (const params of paramSets) {
    const scenario = compose(
      `${fragment.name ?? 'param'}-${JSON.stringify(params)}`,
      [fragment],
      params,
    );

    const runner = new ScenarioRunner(config);
    await runner.init();
    const result = await runner.run(scenario);

    results.push({ params, result });
  }

  return results;
}

/**
 * 格式化参数化结果
 */
export function formatParameterizedResults(results: ParameterizedResult[]): string {
  const lines: string[] = [];

  lines.push(`\n${'═'.repeat(60)}`);
  lines.push(`📋 Parameterized Run: ${results.length} variants`);
  lines.push(`${'═'.repeat(60)}`);

  let passed = 0;
  let failed = 0;

  for (const { params, result } of results) {
    const status = result.passed ? '✅' : '❌';
    if (result.passed) passed++; else failed++;

    lines.push(`\n  ${status} ${JSON.stringify(params)} (${result.durationMs}ms)`);

    for (let i = 0; i < result.turns.length; i++) {
      const turn = result.turns[i];
      const preview = turn.content.substring(0, 60).replace(/\n/g, '\\n');
      lines.push(`     Turn ${i + 1}: ${preview}${turn.content.length > 60 ? '...' : ''}`);
    }

    if (result.failures.length > 0) {
      for (const f of result.failures) {
        lines.push(`     ❌ Turn ${f.turn + 1}: ${f.assertion}`);
      }
    }
  }

  lines.push(`\n${'─'.repeat(60)}`);
  lines.push(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  lines.push(`${'═'.repeat(60)}\n`);

  return lines.join('\n');
}

// ── 内置场景模板库 ──

/**
 * 预定义场景模板
 *
 * 使用者可以直接引用，也可以组合扩展。
 */
export const BuiltinScenarios = {
  /** 基本对话 */
  basicChat: (): ScenarioFragment => ({
    name: 'basic-chat',
    messages: ['你好，请用一句话介绍你自己'],
    assertions: [[(r) => r.isEmpty ? 'Empty response' : null]],
  }),

  /** 文件读写 */
  fileReadWrite: (): ScenarioFragment => ({
    name: 'file-rw',
    messages: [
      '在当前目录创建文件 {filename}，写入 "{content}"',
      '读取 {filename} 的完整内容，只告诉我内容',
    ],
    assertions: [
      [(r) => r.isEmpty ? 'Empty' : null,
       (r) => r.toolCalls.includes('file_write') ? null : 'No file_write'],
      [(r) => r.isEmpty ? 'Empty' : null,
       (r) => r.content.includes('{content}') ? null : 'Content mismatch'],
    ],
  }),

  /** Session 记忆 */
  sessionMemory: (): ScenarioFragment => ({
    name: 'session-memory',
    messages: [
      '记住这个数字：{number}',
      '我让你记住的数字是什么？',
    ],
    assertions: [
      [(r) => r.isEmpty ? 'Empty' : null],
      [(r) => r.content.includes('{number}') ? null : 'Number not found'],
    ],
  }),

  /** 错误恢复 */
  errorRecovery: (): ScenarioFragment => ({
    name: 'error-recovery',
    messages: [
      '读取一个不存在的文件 /tmp/nonexistent-chaos-test-{random}.txt',
      '没关系，你好',
    ],
    assertions: [
      [(r) => r.isEmpty ? 'Empty' : null],
      [(r) => r.isEmpty ? 'Empty' : null],
    ],
  }),

  /** 工具调用链 */
  toolChain: (): ScenarioFragment => ({
    name: 'tool-chain',
    messages: [
      '执行以下操作：1) 创建文件 chain-{random}.txt 写入 "step1" 2) 读取确认 3) 告诉我结果',
    ],
    assertions: [
      [(r) => r.isEmpty ? 'Empty' : null,
       (r) => r.toolCalls.length >= 1 ? null : 'No tools called'],
    ],
  }),
};

// ── 模板引擎 ──

/**
 * 应用模板变量
 */
function applyTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (key === 'random') {
      return Math.random().toString(36).substring(2, 8);
    }
    return params[key] ?? `{${key}}`;
  });
}
