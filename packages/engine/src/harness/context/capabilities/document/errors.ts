/**
 * Document 抽取结构化错误
 *
 * @module harness/context/capabilities/document/errors
 */

import type { ExtractErrorCode } from './types.js';

/**
 * DocumentExtractError — 调用方可按 code 分支，勿匹配 message 文本
 */
export class DocumentExtractError extends Error {
  readonly code: ExtractErrorCode;
  /** 弥补建议，如 requires: ['legacy-converter'] */
  readonly requires?: string[];

  /**
   * @param code - 结构化错误码
   * @param message - 人读说明（不进程序分支）
   * @param requires - 可选弥补能力名
   */
  constructor(code: ExtractErrorCode, message: string, requires?: string[]) {
    super(message);
    this.name = 'DocumentExtractError';
    this.code = code;
    this.requires = requires;
  }
}

/**
 * 类型守卫
 *
 * @param err - 任意异常
 * @returns 是否 DocumentExtractError
 */
export function isDocumentExtractError(err: unknown): err is DocumentExtractError {
  return err instanceof DocumentExtractError;
}
