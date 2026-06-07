/**
 * Testing — 测试工具模块
 *
 * 录制回放 + 场景测试
 */

export { RecordingProvider } from './recording-provider.js';
export type { RecordingEntry, RecordingConfig } from './recording-provider.js';
export { ReplayProvider, createReplayProvider } from './replay-provider.js';
export type { ReplayConfig } from './replay-provider.js';
export { ScenarioRunner, runScenario, formatScenarioResult, notEmpty, contains, notContains, callsTool, noToolCalls, lengthBetween, matches } from './scenario-runner.js';
export type { Scenario, ScenarioAssertion, ScenarioResult, TurnResult, ScenarioRunnerConfig } from './scenario-runner.js';
export { ChaosProvider } from './chaos-provider.js';
export type { ChaosProviderConfig, ChaosRule, EmptyResponseRule, TimeoutRule, MalformedResponseRule, RateLimitRule, ErrorRule, TruncatedResponseRule, PartialToolCallRule } from './chaos-provider.js';
export { compose, extendScenario, runParameterized, formatParameterizedResults, BuiltinScenarios } from './scenario-composer.js';
export type { ScenarioFragment, ParameterizedResult } from './scenario-composer.js';
