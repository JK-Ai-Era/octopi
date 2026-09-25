/**
 * auto-describe — catalog `generatedDescription`
 *
 * 只服务 Tier 0；抽样必须过密钥扫描；可关外发。
 */

import { scanSecretShapes } from './secret-scan.js';
import type { KnowledgeSource } from './types.js';

/** LLM 描述端口（宿主注入；未注入则启发式） */
export type KnowledgeDescribePort = (input: {
  displayName: string;
  kind: string;
  location: string;
  sample: string;
}) => Promise<string>;

export interface KnowledgeDescribeOptions {
  /** 是否允许调用 describePort（默认 true） */
  enabled?: boolean;
  describePort?: KnowledgeDescribePort;
  /** 抽样最大字符（默认 2000） */
  sampleChars?: number;
}

export interface KnowledgeDescribeResult {
  description: string;
  source: 'llm' | 'heuristic' | 'blocked_secret' | 'disabled';
  secretHits?: string[];
}

/**
 * 生成 generatedDescription
 *
 * @param source - 源元数据
 * @param sampleText - 目录树/文件头抽样（调用方提供；P2 起由 ingest 采集）
 */
export async function generateKnowledgeDescription(
  source: Pick<KnowledgeSource, 'displayName' | 'kind' | 'location'>,
  sampleText: string,
  options?: KnowledgeDescribeOptions,
): Promise<KnowledgeDescribeResult> {
  const enabled = options?.enabled !== false;
  const sample = (sampleText ?? '').slice(0, options?.sampleChars ?? 2000);
  const secretHits = scanSecretShapes(sample);

  if (secretHits.length > 0) {
    return {
      description: heuristicDescription(source),
      source: 'blocked_secret',
      secretHits,
    };
  }

  if (!enabled || !options?.describePort) {
    return {
      description: heuristicDescription(source),
      source: options?.describePort ? 'disabled' : 'heuristic',
    };
  }

  try {
    const text = await options.describePort({
      displayName: source.displayName,
      kind: source.kind,
      location: source.location,
      sample,
    });
    const trimmed = text?.trim();
    if (!trimmed) {
      return { description: heuristicDescription(source), source: 'heuristic' };
    }
    return { description: trimmed.slice(0, 300), source: 'llm' };
  } catch {
    return { description: heuristicDescription(source), source: 'heuristic' };
  }
}

/**
 * 启发式一行描述（不能当正确描述，仅 fallback）
 */
export function heuristicDescription(source: {
  displayName: string;
  kind: string;
  location: string;
}): string {
  return `${source.kind} source at ${source.location}`;
}
