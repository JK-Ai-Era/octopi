/**
 * CredentialStore 服务面 — 集成凭证（Knowledge 外源 / http 工具 / connector）
 */

export { CredentialDatabase, resolveCredentialPaths } from './db.js';
export type { CredentialDatabaseOptions, CredentialPaths } from './db.js';
export { CredentialStore } from './store.js';
export {
  loadCredentialMasterKey,
  encryptSecret,
  decryptSecret,
} from './crypto.js';
export { defaultCredentialHeaders } from './types.js';
export type {
  CredentialKind,
  CredentialScopeLevel,
  CredentialScopeRef,
  CredentialConsumerKind,
  CredentialConsumerRef,
  CredentialMeta,
  CredentialWrite,
  ResolvedCredential,
  SecretMode,
} from './types.js';
