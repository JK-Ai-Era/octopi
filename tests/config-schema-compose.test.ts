/**
 * config-schema 按包拆分后的组合行为（arch/npm-package-split.md Phase 1）
 *
 * 覆盖：engine 段 + web（webui）+ gateway 覆盖 的单文件校验。
 */
import { describe, expect, it } from 'vitest';
import {
  GatewayOverrideConfigSchema,
  HarnessConfigSchema,
  OctopiConfigSchema,
  WebConfigSchema,
  engineConfigSchema,
  validateConfig,
  validateConfigOrThrow,
} from '../src/config-schema.js';

const minimalEngine = {
  agents: [{ id: 'a1', model: 'gpt-4o' }],
  models: {
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        api: 'openai-completions' as const,
        models: [{ id: 'gpt-4o' }],
      },
    },
  },
};

describe('config-schema composition (engine + webui + gateway)', () => {
  it('exports OctopiConfigSchema and legacy HarnessConfigSchema as the same schema', () => {
    expect(OctopiConfigSchema).toBe(HarnessConfigSchema);
  });

  it('validates engine-only config', () => {
    const r = validateConfig(minimalEngine);
    expect(r.success).toBe(true);
    expect(r.data?.web).toBeUndefined();
    expect(r.data?.gateway).toBeUndefined();
  });

  it('accepts web (webui) and gateway override sections', () => {
    const r = validateConfig({
      ...minimalEngine,
      web: { dir: './web', host: 'local' },
      gateway: { port: 8787, host: 'lan', debugRest: true },
    });
    expect(r.success).toBe(true);
    expect(r.data?.web?.dir).toBe('./web');
    expect(r.data?.gateway?.port).toBe(8787);
  });

  it('rejects unknown keys in gateway override (additionalProperties: false)', () => {
    const r = validateConfig({
      ...minimalEngine,
      gateway: { port: 1, agents: [] },
    });
    expect(r.success).toBe(false);
  });

  it('WebConfigSchema and GatewayOverrideConfigSchema parse standalone', () => {
    expect(WebConfigSchema.safeParse({ host: 'local' }).success).toBe(true);
    expect(GatewayOverrideConfigSchema.safeParse({ port: 8080 }).success).toBe(true);
    expect(GatewayOverrideConfigSchema.safeParse({ port: -1 }).success).toBe(false);
  });

  it('engineConfigSchema alone rejects missing agents (engine-owned required)', () => {
    const r = engineConfigSchema.safeParse({ models: minimalEngine.models });
    expect(r.success).toBe(false);
  });

  it('validateConfigOrThrow still enforces providerPool → models.providers cross-check', () => {
    expect(() =>
      validateConfigOrThrow({
        ...minimalEngine,
        concurrency: {
          providerPool: {
            slots: [{ provider: 'missing-provider' }],
          },
        },
      }),
    ).toThrow(/missing-provider/);
  });
});
