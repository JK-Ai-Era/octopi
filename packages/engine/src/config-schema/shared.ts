/**
 * 跨段可复用 schema 片段（未来归 @octopi-agent/engine）
 *
 * @module
 */
import { z } from 'zod';

/** 监听 host：local（默认仅本机）| lan（局域网）| 具体 IP/主机名 */
export const NetworkHostSchema = z.union([
  z.enum(['local', 'lan']),
  z.string().min(1),
]);

/** Session 权利字段（ACL E6；agent.maxSessionRights / 角色 defaults） */
export const SessionRightsSchema = z.object({
  canRun: z.boolean().optional(),
  readScope: z.enum(['full', 'from_grant', 'summary_tail', 'none']).optional(),
  writeMemory: z.boolean().optional(),
  canManageTasks: z.boolean().optional(),
  canHandoff: z.boolean().optional(),
});

export const InlinePersonaSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  systemPrompt: z.string({ error: 'Inline persona must have a systemPrompt' }).min(1, 'systemPrompt cannot be empty'),
});

export const ToolPolicySchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

export const InlineModelConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  contextWindow: z.number().positive().optional(),
});

export const ModelConfigSchema = z.object({
  provider: z.string({ error: 'Agent must specify a model provider' }).min(1),
  model: z.string({ error: 'Agent must specify a model' }).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  contextWindow: z.number().positive('contextWindow must be a positive number').optional(),
  fallbackModels: z.array(z.union([z.string().min(1), InlineModelConfigSchema])).optional(),
});
