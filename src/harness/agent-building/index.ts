/**
 * Agent Building 领域 — Agent 构建
 *
 * 职责：组装 Agent 运行时，加载人格配置，桥接配置文件。
 *
 * 依赖：
 * - Core: interfaces/*, types/*, loop/*
 * - Harness: reliability, context, security, concurrency, plugins, mcp, distributed
 */

export { AgentBuilder, createAgent } from './builder.js';
export { loadPersona, composePersonas } from './persona.js';
export { buildFromConfig, buildFromConfigFile, resolveProviders, resolveStore, resolveSecurityConfig } from './config-bridge.js';
export type { BuiltAgent } from './config-bridge.js';
