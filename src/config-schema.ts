/**
 * Config Schema 校验（兼容入口）
 *
 * 真实实现按包边界拆在 `src/config-schema/`（arch/npm-package-split.md Phase 1）。
 * 本文件保持历史 import 路径 `./config-schema.js` 稳定。
 *
 * @module
 */
export * from './config-schema/index.js';
