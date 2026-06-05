/**
 * Harness 层统一导出
 *
 * Layer 2: 装具层
 * 通过 Core 接口挂载增强功能
 */

// ── Persona ──
export { loadPersona, composePersonas } from './persona/loader.js';

// ── Context Pipeline ──
export { DefaultContextPipeline, PersonaStage, HistoryStage, FilterStage } from './context/pipeline.js';
export type { ContextStage, StageContext } from './context/pipeline.js';

// ── Runner ──
export { SessionAwareRunner } from './runner.js';
export type { SessionAwareRunnerConfig } from './runner.js';

// ── Builder ──
export { AgentBuilder, createAgent } from './builder.js';

// ── 兼容层 ──
export { LegacyAgentRunner } from './compat/legacy-agent-runner.js';
export { adaptPluginHooks } from './compat/plugin-adapter.js';
