/**
 * CredentialStore 类型 — 集成/资源访问凭证（非系统级 provider key）
 *
 * 密钥材料不以明文持久化；knowledge.db / octopi.json 只存引用。
 */

export type CredentialKind = 'bearer' | 'basic' | 'api_key' | 'header_map' | 'oauth2_client';

export type SecretMode = 'env' | 'encrypted' | 'file';

export type CredentialScopeLevel = 'global' | 'project' | 'agent';

export interface CredentialScopeRef {
  level: CredentialScopeLevel;
  key: string;
}

export type CredentialConsumerKind = 'knowledge_source' | 'tool' | 'agent' | 'connector';

export interface CredentialConsumerRef {
  kind: CredentialConsumerKind;
  id: string;
}

/** 元数据（可出 API；无密文） */
export interface CredentialMeta {
  id: string;
  name: string;
  kind: CredentialKind;
  description?: string;
  username?: string;
  headerName?: string;
  headerPrefix?: string;
  secretMode: SecretMode;
  /** mode=env 时的变量名（非密） */
  secretEnv?: string;
  /** mode=file 时的路径（非密） */
  secretFile?: string;
  hasSecret: boolean;
  scope: CredentialScopeRef;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
}

export interface CredentialWrite {
  name: string;
  kind: CredentialKind;
  description?: string;
  username?: string;
  headerName?: string;
  headerPrefix?: string;
  secretMode?: SecretMode;
  /** mode=env：环境变量名 */
  secretEnv?: string;
  /** mode=env 时也可用明文写入并自动落到 env 不可能时的 encrypted — U1 仅支持 env/file 引用 */
  secretFile?: string;
  /** mode=encrypted 明文（仅写入路径；U1 可不启用） */
  secretValue?: string;
  scope?: CredentialScopeRef;
  expiresAt?: number;
}

/** 进程内短命解析结果；禁止日志/持久化 */
export interface ResolvedCredential {
  name: string;
  headers: Record<string, string>;
}

export function defaultCredentialHeaders(input: {
  kind: CredentialKind;
  username?: string;
  headerName?: string;
  headerPrefix?: string;
  secret: string;
}): Record<string, string> {
  const { kind, username, headerName, headerPrefix, secret } = input;
  if (kind === 'basic') {
    const token = Buffer.from(`${username ?? ''}:${secret}`, 'utf8').toString('base64');
    return { Authorization: `Basic ${token}` };
  }
  if (kind === 'bearer') {
    return { Authorization: `${headerPrefix ?? 'Bearer '}${secret}` };
  }
  if (kind === 'api_key') {
    return { [headerName ?? 'X-API-Key']: secret };
  }
  if (kind === 'header_map') {
    // secret 形如 "Header-Name: value" 或纯值 + headerName
    const idx = secret.indexOf(':');
    if (!headerName && idx > 0) {
      const h = secret.slice(0, idx).trim();
      const v = secret.slice(idx + 1).trim();
      return { [h]: v };
    }
    return { [headerName ?? 'Authorization']: secret };
  }
  // oauth2_client：U1 仅当已换成 access token 时按 bearer
  return { Authorization: `${headerPrefix ?? 'Bearer '}${secret}` };
}
