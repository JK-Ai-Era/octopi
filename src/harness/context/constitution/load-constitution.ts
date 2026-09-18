/**
 * Constitution loader — 全局运行宪法
 *
 * 产品资产 `default-agents.md`：**仅可执行指令**（英文），会注入 system prompt。
 * 产品归属/装配语义/集成商说明写在 docs，不进宪法正文。
 *
 * @module harness/context/constitution/load-constitution
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ConstitutionMode = 'product' | 'custom' | 'off';

export interface ConstitutionConfig {
  mode: ConstitutionMode;
  /** custom 模式必填 */
  path?: string | null;
}

export interface LoadedConstitution {
  mode: ConstitutionMode;
  text: string;
  source: 'product' | 'custom' | 'none';
  path?: string;
}

/** 解析产品默认宪法文件路径 */
export function productConstitutionPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'default-agents.md');
}

function packageRootFromHere(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src|dist/harness/context/constitution → package root
  return resolve(here, '../../..');
}

function resolveProductMarkdown(): string | null {
  const candidates = [
    productConstitutionPath(),
    join(packageRootFromHere(), 'src', 'harness', 'context', 'constitution', 'default-agents.md'),
    join(packageRootFromHere(), 'dist', 'harness', 'context', 'constitution', 'default-agents.md'),
    join(packageRootFromHere(), 'harness', 'context', 'constitution', 'default-agents.md'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 加载宪法正文
 *
 * - product: 读包内 default-agents.md；缺失时返回空（装配跳过）
 * - custom: path 必填；路径非法抛错（build 失败，不静默）
 * - off: 空文本
 */
export function loadConstitution(config?: ConstitutionConfig | null): LoadedConstitution {
  const mode = config?.mode ?? 'product';

  if (mode === 'off') {
    return { mode: 'off', text: '', source: 'none' };
  }

  if (mode === 'custom') {
    const raw = config?.path;
    if (!raw || !String(raw).trim()) {
      throw new Error('constitution.mode=custom requires context.constitution.path');
    }
    const p = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
    if (!existsSync(p)) {
      throw new Error(`constitution.mode=custom path not found: ${p}`);
    }
    const text = readFileSync(p, 'utf-8');
    return { mode: 'custom', text, source: 'custom', path: p };
  }

  // product
  const p = resolveProductMarkdown();
  if (!p) {
    return { mode: 'product', text: '', source: 'none' };
  }
  const text = readFileSync(p, 'utf-8');
  return { mode: 'product', text, source: 'product', path: p };
}
