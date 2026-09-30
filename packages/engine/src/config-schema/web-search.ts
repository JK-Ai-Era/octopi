/**
 * webSearch — Web Search 工具段（→ engine）
 *
 * @module
 */
import { z } from 'zod';

const WebSearchProviderSlotSchema = z.object({
  api: z.enum(['duckduckgo', 'tavily', 'brave', 'serper', 'mimo']),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
  model: z.string().min(1).optional(),
  maxKeyword: z.number().int().min(1).max(10).optional(),
  forceSearch: z.boolean().optional(),
  userLocation: z.object({
    country: z.string().optional(),
    region: z.string().optional(),
    city: z.string().optional(),
  }).optional(),
});

export const WebSearchConfigSchema = z.object({
  provider: z.string().min(1).optional(),
  fallbacks: z.array(z.string().min(1)).optional(),
  defaultLimit: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().positive().optional(),
  providers: z.record(z.string().min(1), WebSearchProviderSlotSchema).optional(),
}).refine(
  (data) => {
    if (!data.provider || !data.providers) return true;
    if (!data.providers[data.provider]) {
      return false;
    }
    return true;
  },
  { message: 'webSearch.provider must reference a key in webSearch.providers' },
).refine(
  (data) => {
    if (!data.fallbacks || !data.providers) return true;
    return data.fallbacks.every((k) => data.providers![k] !== undefined);
  },
  { message: 'webSearch.fallbacks entries must reference keys in webSearch.providers' },
);
