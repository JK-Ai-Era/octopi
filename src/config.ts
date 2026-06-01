/**
 * 配置系统
 *
 * 支持从 JSON 配置文件或环境变量加载 Gateway 配置。
 * 配置文件默认路径：./agent-harness.json
 *
 * 配置示例：
 * ```json
 * {
 *   "agents": [{
 *     "id": "assistant",
 *     "workspace": "./workspace",
 *     "persona": {
 *       "name": "Assistant",
 *       "description": "A helpful assistant",
 *       "systemPrompt": "You are a helpful assistant."
 *     },
 *     "tools": { "allow": ["*"] },
 *     "model": {
 *       "provider": "openai",
 *       "model": "gpt-4o"
 *     }
 *   }],
 *   "providers": [{
 *     "type": "openai",
 *     "name": "openai",
 *     "apiKey": "${OPENAI_API_KEY}",
 *     "models": ["gpt-4o", "gpt-4o-mini"]
 *   }],
 *   "channels": [{
 *     "type": "http",
 *     "port": 3000
 *   }],
 *   "session": {
 *     "dmScope": "per-peer"
 *   }
 * }
 * ```
 */

import type { AgentDefinition, GatewayConfig } from './core/types.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Provider 配置
 */
export interface ProviderConfig {
  /** 类型（openai、custom） */
  type: string;
  /** 名称 */
  name: string;
  /** API Key（支持 ${ENV_VAR} 语法） */
  apiKey?: string;
  /** Base URL */
  baseUrl?: string;
  /** 支持的模型 */
  models?: string[];
  /** 默认模型 */
  defaultModel?: string;
}

/**
 * Channel 配置
 */
export interface ChannelConfig {
  /** 类型（http） */
  type: string;
  /** 端口（HTTP channel 用） */
  port?: number;
  /** 路径（HTTP channel 用） */
  path?: string;
}

/**
 * 完整配置文件结构
 */
export interface HarnessConfig {
  /** Agent 列表 */
  agents: AgentDefinition[];
  /** Provider 列表 */
  providers?: ProviderConfig[];
  /** Channel 列表 */
  channels?: ChannelConfig[];
  /** Session 配置 */
  session?: GatewayConfig['session'];
}

/**
 * 从配置文件加载配置
 *
 * @param configPath - 配置文件路径（默认 ./agent-harness.json）
 * @returns 解析后的配置
 */
export function loadConfig(configPath?: string): HarnessConfig {
  const filePath = resolve(configPath ?? './agent-harness.json');

  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf-8');

  // 支持 ${ENV_VAR} 环境变量替换
  const expanded = raw.replace(/\$\{(\w+)\}/g, (_, key) => {
    return process.env[key] ?? '';
  });

  const config = JSON.parse(expanded) as HarnessConfig;

  // 基本校验
  if (!config.agents || config.agents.length === 0) {
    throw new Error('Config must define at least one agent');
  }

  for (const agent of config.agents) {
    if (!agent.id) throw new Error('Agent must have an id');
    if (!agent.persona?.systemPrompt) throw new Error(`Agent "${agent.id}" must have a systemPrompt`);
    if (!agent.model?.provider) throw new Error(`Agent "${agent.id}" must specify a model provider`);
    if (!agent.model?.model) throw new Error(`Agent "${agent.id}" must specify a model`);
  }

  return config;
}

/**
 * 将 HarnessConfig 转换为 GatewayConfig
 */
export function toGatewayConfig(config: HarnessConfig): GatewayConfig {
  return {
    agents: config.agents,
    session: config.session,
  };
}
