/**
 * Gateway 配置类型
 *
 * Integration 层类型。Gateway 是 Integration 层组件。
 */

import type { AgentDefinition } from '../../core/types/agent-definition.js';

export interface GatewayConfig {
  port?: number;
  agents: AgentDefinition[];
  budget?: {
    maxIterations?: number;
    maxToolCalls?: number;
    maxTokens?: number;
    maxWallClockMs?: number;
  };
  session?: {
    dmScope?: 'main' | 'per-peer' | 'per-channel-peer';
    reset?: {
      dailyHour?: number;
      idleMinutes?: number;
    };
    maintenance?: {
      mode?: 'warn' | 'enforce';
      pruneAfter?: string;
      maxEntries?: number;
    };
  };
  trace?: {
    outputDir?: string;
    level?: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';
    captureToolArgs?: boolean;
    captureToolResults?: boolean;
  };
  modelCallIdleTimeoutMs?: number;
}
