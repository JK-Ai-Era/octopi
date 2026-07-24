/**
 * ToolCallRiskPolicy — 注入到 Core SecurityGuard 的风险策略接口
 *
 * 接口定义在 Core 层（src/core/security-guard.ts）。
 * 此文件重新导出，方便 Harness 层使用。
 */

export type { ToolCallRiskPolicy } from '../../core/security-guard.js';
