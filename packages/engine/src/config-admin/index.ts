/**
 * config-admin — 配置管理面纯逻辑（arch/config-hot-reload.md）
 *
 * 段级 raw JSON 读写 / 乐观锁 hash / 脱敏 / provider 预设展开。
 * 文件 IO 在根包 FileConfigService；本模块纯函数无 IO，可独立测试。
 *
 * @module
 */

export { assertSafeConfigName } from './name-guard.js';

export {
  BUILTIN_AGENT_ROLE_PRESETS,
  getAgentRolePreset,
  renderAgentRole,
} from './agent-presets.js';
export type {
  AgentRolePreset,
  AgentRoleSlots,
  RenderedAgentRole,
  EffectMode,
} from './agent-presets.js';

export {
  BUILTIN_MODEL_PRESETS,
  getProviderPreset,
  listProviderPresets,
  expandProviderPreset,
} from './model-presets.js';
export type { ModelPresetModel, ProviderPreset } from './model-presets.js';

export { redactSecret, redactProvider } from './redact.js';
export type { RedactedSecret, RedactedProvider } from './redact.js';

export {
  computeConfigHash,
  getJsonPath,
  setJsonPath,
  deleteJsonPath,
  findProviderReferences,
} from './patch.js';

export { ConfigConflictError } from './port.js';
export type {
  ConfigAdminPort,
  ConfigAdminSnapshot,
  ConfigAdminWriteResult,
} from './port.js';

export { discoverProviderModels } from './discover.js';
export type { DiscoverModelsRequest, DiscoverModelsResult } from './discover.js';
