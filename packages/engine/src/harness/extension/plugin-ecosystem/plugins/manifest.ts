/**
 * Installation-time plugin declaration. This module must remain safe to use
 * before importing plugin code.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { z } from 'zod';

export const PLUGIN_API_VERSION = '1' as const;

export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
}

const jsonSchemaSchema: z.ZodType<JsonSchema> = z.lazy(() =>
  z
    .object({
      type: z.enum(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']).optional(),
      properties: z.record(z.string(), jsonSchemaSchema).optional(),
      required: z.array(z.string().min(1)).optional(),
      additionalProperties: z.union([z.boolean(), jsonSchemaSchema]).optional(),
      items: jsonSchemaSchema.optional(),
      enum: z.array(z.unknown()).min(1).optional(),
      default: z.unknown().optional(),
      description: z.string().optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      pattern: z.string().optional(),
      oneOf: z.array(jsonSchemaSchema).min(1).optional(),
      anyOf: z.array(jsonSchemaSchema).min(1).optional(),
      allOf: z.array(jsonSchemaSchema).min(1).optional(),
    })
    .strict(),
);

export const PLUGIN_HOOK_NAMES = [
  'before_model_resolve',
  'agent_turn_prepare',
  'before_prompt_build',
  'before_agent_run',
  'before_agent_reply',
  'before_agent_finalize',
  'agent_end',
  'before_tool_call',
  'after_tool_call',
  'message_received',
  'message_sending',
  'message_sent',
  'session_start',
  'session_end',
  'before_compaction',
  'after_compaction',
  'gateway_start',
  'gateway_stop',
  'before_install',
  'before_iteration',
  'after_iteration',
  'loop_end',
] as const;

export type PluginHookName = (typeof PLUGIN_HOOK_NAMES)[number];
export const PLUGIN_SESSION_OP_NAMES = ['abort_run', 'new_session', 'set_model', 'compact', 'set_preferred_agent'] as const;
export type PluginSessionOpName = (typeof PLUGIN_SESSION_OP_NAMES)[number];

const contributionName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/, 'must be a stable capability name');
const pluginId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'must be a lowercase stable plugin id');

const manifestSchema = z
  .object({
    id: pluginId,
    apiVersion: z.literal(PLUGIN_API_VERSION),
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    entry: z.string().min(1),
    enabledByDefault: z.boolean().optional(),
    engine: z.object({ octopi: z.string().min(1) }).strict(),
    configSchema: jsonSchemaSchema,
    contributes: z
      .object({
        tools: z.array(contributionName).optional(),
        commands: z
          .array(
            z
              .object({
                name: contributionName,
                sessionOps: z.array(z.enum(PLUGIN_SESSION_OP_NAMES)).optional(),
              })
              .strict(),
          )
          .optional(),
        hooks: z.array(z.enum(PLUGIN_HOOK_NAMES)).optional(),
        services: z.array(contributionName).optional(),
      })
      .strict()
      .optional(),
    requiresPlugins: z.array(pluginId).optional(),
    legacyPluginIds: z.array(pluginId).optional(),
  })
  .strict();

export interface PluginCommandContribution {
  name: string;
  sessionOps?: PluginSessionOpName[];
}

export interface PluginContributions {
  tools?: string[];
  commands?: PluginCommandContribution[];
  hooks?: PluginHookName[];
  /** Stable service ids; required/timeout are trusted Host execution policy. */
  services?: string[];
}

export interface PluginManifest {
  id: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  version: string;
  name: string;
  description?: string;
  entry: string;
  enabledByDefault?: boolean;
  engine: { octopi: string };
  configSchema: JsonSchema;
  contributes?: PluginContributions;
  requiresPlugins?: string[];
  legacyPluginIds?: string[];
}

/**
 * Validate a declaration without importing the plugin entry.
 *
 * @param raw - Parsed manifest JSON
 * @returns Strictly validated v1 manifest
 */
export function validateManifest(raw: unknown): PluginManifest {
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid plugin manifest: ${z.prettifyError(result.error)}`);
  }
  const manifest = result.data as PluginManifest;
  assertUnique(manifest.requiresPlugins ?? [], 'requiresPlugins');
  assertUnique(manifest.legacyPluginIds ?? [], 'legacyPluginIds');
  if (manifest.legacyPluginIds?.includes(manifest.id)) {
    throw new Error(`Plugin "${manifest.id}" cannot list itself in legacyPluginIds`);
  }
  assertUnique(manifest.contributes?.tools ?? [], 'contributes.tools');
  assertUnique(manifest.contributes?.hooks ?? [], 'contributes.hooks');
  assertUnique(manifest.contributes?.services ?? [], 'contributes.services');
  const commands = manifest.contributes?.commands ?? [];
  assertUnique(commands.map((command) => command.name), 'contributes.commands');
  for (const command of commands) {
    assertUnique(command.sessionOps ?? [], `contributes.commands.${command.name}.sessionOps`);
  }
  createConfigValidator(manifest.configSchema);
  return manifest;
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Plugin manifest ${field} contains duplicate entries`);
  }
}

/**
 * Parse and validate an octopi.plugin.json document.
 *
 * @param json - Manifest JSON text
 * @returns Strictly validated v1 manifest
 */
export function parseManifest(json: string): PluginManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Plugin manifest is not valid JSON');
  }
  return validateManifest(raw);
}

function createConfigValidator(schema: JsonSchema): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: false, useDefaults: true });
  return ajv.compile(schema);
}

/**
 * Validate plugin business config before importing the plugin module.
 *
 * @param manifest - Validated manifest
 * @param config - Plugin-local business config
 * @returns A cloned config, including schema defaults applied by Ajv
 */
export function validatePluginConfig(
  manifest: PluginManifest,
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const validate = createConfigValidator(manifest.configSchema);
  const value = config === undefined ? {} : structuredClone(config);
  if (!validate(value)) {
    const details = (validate.errors ?? []).map(formatConfigError).join('; ');
    throw new Error(`Plugin "${manifest.id}" config validation failed: ${details}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Plugin "${manifest.id}" config must be an object`);
  }
  return value as Record<string, unknown>;
}

function formatConfigError(error: ErrorObject): string {
  const path = error.instancePath || '/';
  return `${path} ${error.message ?? 'is invalid'}`;
}
