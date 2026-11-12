/**
 * Registry — 租户与定义面（arch/multi-tenancy.md）
 *
 * 拥有：Tenant / User / Agent 定义 / Binding（渠道路由）/ Mount（知识挂载）。
 * 所有权锚=tenantId；「租户内是引用，跨租户是集成」。
 */
export * from './types.js';
export * from './db.js';
export * from './service.js';
