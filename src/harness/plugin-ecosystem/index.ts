/**
 * Plugin Ecosystem 领域 — 插件生态
 *
 * 职责：Plugin 系统、Skill 管理、工具注册、MCP 集成、斜杠命令。
 */
export * from './plugins/index.js';
export * from './tools/index.js';
export { DefaultSkillManager, FileSystemSkillSource } from './skills/manager.js';
export type { SkillSource, DiscoveredSkill } from './skills/manager.js';
export * from './mcp/index.js';
export * from './commands/index.js';
