/**
 * agents / plugins / channels — Extension & Agent 段（→ @octopi-agent/engine）
 *
 * @module
 */
import { z } from 'zod';
import {
  InlinePersonaSchema,
  ModelConfigSchema,
  NetworkHostSchema,
  SessionRightsSchema,
  ToolPolicySchema,
} from './shared.js';

export const AgentConfigSchema = z.object({
  id: z.string({ error: 'Agent must have an id' }).min(1, 'Agent id cannot be empty'),
  home: z.string().optional(),
  workspace: z.string().optional(),
  persona: z.union([z.string(), InlinePersonaSchema]).optional(),
  model: z.union([z.string().min(1), ModelConfigSchema]),
  tools: ToolPolicySchema.optional(),
  skillDirectory: z.string().optional(),
  skills: z.array(z.string()).optional(),
  channelBindings: z.record(z.string(), z.string()).optional(),
  /** Session ACL 天花板（E6 L1）；与角色 max / 绑定取交集 */
  maxSessionRights: SessionRightsSchema.optional(),
  /** Knowledge 召回（覆盖全局 knowledge.recall） */
  knowledge: z
    .object({
      recall: z.enum(['off', 'hint', 'hybrid', 'inject']).optional(),
    })
    .optional(),
});

export const PluginConfigSchema = z.object({
  loadPaths: z.array(z.string()).optional(),
  configs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export const ChannelConfigSchema = z.object({
  type: z.string({ error: 'Channel must have a type' }).min(1),
  port: z.number().positive().optional(),
  host: NetworkHostSchema.optional(),
  path: z.string().optional(),
  apiKey: z.string().optional(),
  corsOrigins: z.array(z.string()).optional(),
});
