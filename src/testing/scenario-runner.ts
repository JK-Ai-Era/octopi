/**
 * ScenarioRunner — E2E 场景测试运行器
 *
 * 定义和运行完整的对话场景，验证端到端正确性。
 *
 * 使用方式：
 * ```ts
 * const result = await runScenario({
 *   name: 'tool-file-rw',
 *   messages: [
 *     '创建文件 test.txt 写入 hello',
 *     '读取 test.txt 的内容',
 *   ],
 *   assertions: [
 *     [notEmpty(), callsTool('file_write')],
 *     [notEmpty(), contains('hello'), callsTool('file_read')],
 *   ],
 * }, { provider, workspaceDir });
 * ```
 */

import type { ModelProvider } from '../core/interfaces/model-provider.js';
import type { SessionStore } from '../core/interfaces/session-store.js';
import type { RegisteredTool, AgentEvent } from '../core/types.js';
import { AgentBuilder } from '../harness/builder.js';
import { SessionAwareRunner } from '../harness/runner.js';
import type { RunConfig, AgentEngine } from '../core/engine.js';
import { TraceCollector, type TraceCollectorConfig } from '../observability/trace-collector.js';

// ── 场景定义 ──

/** 单条消息的断言 */
export type ScenarioAssertion = (result: TurnResult) => string | null;

/** 单轮结果 */
export interface TurnResult {
  /** 回复内容 */
  content: string;
  /** 调用的工具名列表 */
  toolCalls: string[];
  /** 所有事件类型 */
  events: string[];
  /** 完整事件（可选） */
  fullEvents?: AgentEvent[];
  /** 是否为空回复 */
  isEmpty: boolean;
  /** 耗时 */
  durationMs: number;
}

/** 场景定义 */
export interface Scenario {
  /** 场景名称 */
  name: string;
  /** 消息序列 */
  messages: string[];
  /** 每条消息的断言（数量应与 messages 一致） */
  assertions?: ScenarioAssertion[][];
  /** 额外的运行配置 */
  config?: {
    /** 最大重试次数（某轮失败时） */
    maxRetries?: number;
    /** 轮间延迟（ms） */
    turnDelayMs?: number;
  };
}

/** 场景运行结果 */
export interface ScenarioResult {
  /** 场景名称 */
  name: string;
  /** 是否全部通过 */
  passed: boolean;
  /** 每轮结果 */
  turns: TurnResult[];
  /** 断言失败详情 */
  failures: Array<{ turn: number; message: string; assertion: string }>;
  /** 总耗时 */
  durationMs: number;
  /** Trace 文件路径 */
  tracePath?: string;
}

// ── 内置断言 ──

/** 断言：回复不为空 */
export function notEmpty(): ScenarioAssertion {
  return (result) => result.isEmpty ? 'Response is empty' : null;
}

/** 断言：回复包含指定文本 */
export function contains(text: string): ScenarioAssertion {
  return (result) => result.content.includes(text) ? null : `Response does not contain "${text}"`;
}

/** 断言：回复不包含指定文本 */
export function notContains(text: string): ScenarioAssertion {
  return (result) => !result.content.includes(text) ? null : `Response should not contain "${text}"`;
}

/** 断言：调用了指定工具 */
export function callsTool(name: string): ScenarioAssertion {
  return (result) => result.toolCalls.includes(name) ? null : `Tool "${name}" was not called (called: ${result.toolCalls.join(', ') || 'none'})`;
}

/** 断言：没有调用工具 */
export function noToolCalls(): ScenarioAssertion {
  return (result) => result.toolCalls.length === 0 ? null : `Expected no tool calls, but called: ${result.toolCalls.join(', ')}`;
}

/** 断言：回复长度在范围内 */
export function lengthBetween(min: number, max: number): ScenarioAssertion {
  return (result) => {
    const len = result.content.length;
    return len >= min && len <= max ? null : `Response length ${len} not in range [${min}, ${max}]`;
  };
}

/** 断言：回复匹配正则 */
export function matches(pattern: RegExp): ScenarioAssertion {
  return (result) => pattern.test(result.content) ? null : `Response does not match ${pattern}`;
}

// ── ScenarioRunner ──

export interface ScenarioRunnerConfig {
  /** LLM Provider */
  provider: ModelProvider;
  /** 工作目录 */
  workspaceDir: string;
  /** Session 存储 */
  store?: SessionStore;
  /** 工具列表 */
  tools?: RegisteredTool[];
  /** Trace 配置 */
  trace?: TraceCollectorConfig;
}

/**
 * ScenarioRunner
 */
export class ScenarioRunner {
  private config: ScenarioRunnerConfig;
  private runner!: SessionAwareRunner;
  private engine!: AgentEngine;
  private traceCollector?: TraceCollector;

  constructor(config: ScenarioRunnerConfig) {
    this.config = config;
  }

  /**
   * 初始化（必须在 run 之前调用）
   */
  async init(): Promise<void> {
    const builder = new AgentBuilder()
      .model(this.config.provider)
      .persona(this.config.workspaceDir);

    if (this.config.store) {
      builder.store(this.config.store);
    }

    for (const tool of this.config.tools ?? []) {
      builder.tool(tool);
    }

    const built = await builder.build();
    this.engine = built.engine;
    this.runner = built.runner;

    if (this.config.trace) {
      this.traceCollector = new TraceCollector(this.config.trace);
    }
  }

  /**
   * 运行场景
   */
  async run(scenario: Scenario): Promise<ScenarioResult> {
    const start = Date.now();
    const sessionId = `scenario:${scenario.name}:${Date.now()}`;
    const turns: TurnResult[] = [];
    const failures: ScenarioResult['failures'] = [];

    for (let i = 0; i < scenario.messages.length; i++) {
      const message = scenario.messages[i];
      const maxRetries = scenario.config?.maxRetries ?? 0;

      let result: TurnResult | null = null;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          result = await this.runTurn(sessionId, message, scenario.name);
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          }
        }
      }

      if (!result) {
        result = {
          content: '',
          toolCalls: [],
          events: [],
          isEmpty: true,
          durationMs: 0,
        };
        failures.push({
          turn: i,
          message,
          assertion: `Turn failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
        });
      }

      turns.push(result);

      // 运行断言
      const assertions = scenario.assertions?.[i] ?? [];
      for (const assertion of assertions) {
        const failMsg = assertion(result);
        if (failMsg) {
          failures.push({ turn: i, message, assertion: failMsg });
        }
      }

      // 轮间延迟
      const delayMs = scenario.config?.turnDelayMs;
      if (delayMs && i < scenario.messages.length - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    // 结束 trace
    this.traceCollector?.finalize();

    return {
      name: scenario.name,
      passed: failures.length === 0,
      turns,
      failures,
      durationMs: Date.now() - start,
      tracePath: this.traceCollector?.getFilePath(),
    };
  }

  /**
   * 运行单轮
   */
  private async runTurn(sessionId: string, content: string, scenarioName: string): Promise<TurnResult> {
    const start = Date.now();

    const userMessage = {
      role: 'user' as const,
      content,
      timestamp: Date.now(),
    };

    const runConfig: RunConfig = {
      agentId: 'scenario',
      sessionId,
      model: this.config.provider.name,
      systemPrompt: '',
      cwd: this.config.workspaceDir,
    };

    let finalContent = '';
    const toolCalls: string[] = [];
    const events: string[] = [];

    let eventStream = this.runner.handle(sessionId, userMessage, runConfig);

    // 如果有 trace collector，包装事件流
    if (this.traceCollector) {
      eventStream = this.traceCollector.wrap(eventStream, {
        sessionId,
        agentId: 'scenario',
      });
    }

    for await (const event of eventStream) {
      events.push(event.type);

      if (event.type === 'llm_stream_delta' && event.data?.delta) {
        finalContent += event.data.delta as string;
      }
      if (event.type === 'tool.exec.start') {
        toolCalls.push(event.data?.toolName as string);
      }
      if (event.type === 'turn.end' && event.data?.content && !finalContent) {
        finalContent = event.data.content as string;
      }
    }

    const content_trimmed = finalContent.trim();

    return {
      content: content_trimmed,
      toolCalls,
      events,
      isEmpty: content_trimmed.length === 0,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * 快捷函数：运行单个场景
 */
export async function runScenario(
  scenario: Scenario,
  config: ScenarioRunnerConfig,
): Promise<ScenarioResult> {
  const runner = new ScenarioRunner(config);
  await runner.init();
  return runner.run(scenario);
}

/**
 * 格式化场景结果（人类可读）
 */
export function formatScenarioResult(result: ScenarioResult): string {
  const lines: string[] = [];

  lines.push(`\n${'═'.repeat(60)}`);
  lines.push(`📋 Scenario: ${result.name}`);
  lines.push(`${'═'.repeat(60)}`);
  lines.push(`Status: ${result.passed ? '✅ PASSED' : '❌ FAILED'}`);
  lines.push(`Duration: ${result.durationMs}ms`);
  lines.push(`Turns: ${result.turns.length}`);
  if (result.tracePath) {
    lines.push(`Trace: ${result.tracePath}`);
  }

  for (let i = 0; i < result.turns.length; i++) {
    const turn = result.turns[i];
    const preview = turn.content.substring(0, 80).replace(/\n/g, '\\n');
    const tools = turn.toolCalls.length > 0 ? ` [tools: ${turn.toolCalls.join(', ')}]` : '';
    lines.push(`\n  Turn ${i + 1} (${turn.durationMs}ms)${tools}:`);
    lines.push(`    ${preview}${turn.content.length > 80 ? '...' : ''}`);
  }

  if (result.failures.length > 0) {
    lines.push(`\n${'─'.repeat(60)}`);
    lines.push(`❌ Failures (${result.failures.length}):`);
    for (const f of result.failures) {
      lines.push(`  Turn ${f.turn + 1}: ${f.assertion}`);
      lines.push(`    Input: "${f.message}"`);
    }
  }

  lines.push(`${'═'.repeat(60)}\n`);
  return lines.join('\n');
}
