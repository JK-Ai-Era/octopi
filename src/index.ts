/**
 * Octopi — 可嵌入的 Agent 底座框架
 *
 * 根入口为兼容 re-export（arch/npm-package-split.md §10.3）：
 * 业务能力在 `@octopi-agent/engine`；本文件只保留 gateway / init / testing / config IO。
 *
 * 快速开始：
 * ```ts
 * import { AgentBuilder } from 'octopi-agent';
 *
 * const { engine, runner } = await new AgentBuilder()
 *   .model('gpt-5.5')
 *   .persona('./my-agent')
 *   .build();
 * ```
 */

// Engine 上帝导出（Harness + Integration 库能力 + config 类型/工厂）
export * from '@octopi-agent/engine';

// ============================================================
// Gateway / 协议
// ============================================================

export * from '@octopi-agent/gateway';


// ============================================================
// Config IO + 组合校验
// ============================================================

export { loadConfig, toGatewayConfig, buildFromConfigFile } from './config.js';
export { validateConfig, validateConfigOrThrow, HarnessConfigSchema, OctopiConfigSchema } from './config-schema.js';
export type { ConfigValidationResult, ConfigValidationError } from './config-schema.js';

// ============================================================
// Init
// ============================================================

export { initOctopi, ensureAgentDirs, isInitialized, getOctopiHome, formatInitReport } from './init.js';

// ============================================================
// Testing
// ============================================================

export { RecordingProvider, ReplayProvider, createReplayProvider, ScenarioRunner, runScenario, formatScenarioResult, ChaosProvider, compose, extendScenario, runParameterized, formatParameterizedResults, BuiltinScenarios, notEmpty, contains, notContains, callsTool, noToolCalls, lengthBetween, matches } from './testing/index.js';
export type { RecordingEntry, RecordingConfig, ReplayConfig, Scenario, ScenarioAssertion, ScenarioResult, TurnResult, ScenarioRunnerConfig, ChaosProviderConfig, ChaosRule, ScenarioFragment, ParameterizedResult } from './testing/index.js';
