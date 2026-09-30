/**
 * Generate octopi.schema.json from the composed Zod schema (suite owns the file).
 * Kills Zod / JSON Schema dual-source drift (arch/npm-package-split.md §5.5 / §8).
 *
 * Usage: node scripts/generate-octopi-schema.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaMod = await import(pathToFileURL(join(root, 'dist', 'config-schema', 'index.js')).href);
const { OctopiConfigSchema } = schemaMod;

const jsonSchema = z.toJSONSchema(OctopiConfigSchema, {
  io: 'input',
  unrepresentable: 'any',
});

jsonSchema.$schema = 'http://json-schema.org/draft-07/schema#';
jsonSchema.title = 'Octopi Config';
jsonSchema.description = 'octopi.json — 单文件配置（engine + gateway + web 段；由 Zod 组合 schema 生成）';

const out = join(root, 'octopi.schema.json');
writeFileSync(out, JSON.stringify(jsonSchema, null, 2) + '\n');
console.log('[generate-octopi-schema] wrote', out);
