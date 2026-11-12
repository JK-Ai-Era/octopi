/**
 * Registry types — 租户与定义面实体模型（arch/multi-tenancy.md §3）。
 *
 * 所有权锚 = tenantId（隔离/审计/转移的钥匙）；ownerUserId = 管理归属；
 * visibility 决定租户内可见性。「一用户一租户」是策略默认，不是 schema 约束。
 */

import type { Branded } from '../../knowledge/types.js';

export type TenantId = Branded<string, 'TenantId'>;
export type UserId = Branded<string, 'UserId'>;
export type AgentId = Branded<string, 'AgentId'>;
export type BindingId = Branded<string, 'BindingId'>;
export type MountId = Branded<string, 'MountId'>;
export type KnowledgeSourceId = Branded<string, 'KnowledgeSourceId'>;

/** agent 在租户内的可见性：private=仅 owner；tenant=租户共享 */
export type AgentVisibility = 'private' | 'tenant';

/** 渠道会话策略：per-user 常驻 / per-chat 群会话 / per-message 单发 */
export type SessionPolicy = 'per-user' | 'per-chat' | 'per-message';

/** 挂载消费方：agent / project / session */
export type MountConsumerType = 'agent' | 'project' | 'session';

/** 挂载资产类型：knowledge 知识库 / project 项目 */
export type MountSourceType = 'knowledge' | 'project';

/** 资产所有权：platform 公共（跨租户共享唯一合法形态）/ tenant 私有 */
export type SourceScope = 'platform' | 'tenant';

export interface Tenant {
  tenantId: TenantId;
  name: string;
  createdAt: number;
}

export interface User {
  userId: UserId;
  tenantId: TenantId;
  name: string;
  /** 平台 admin（Q13：首个注册用户；管理 platform 公共资产） */
  isPlatformAdmin: boolean;
  createdAt: number;
}

export interface AgentRecord {
  agentId: AgentId;
  tenantId: TenantId;
  ownerUserId: UserId;
  visibility: AgentVisibility;
  name: string;
  /** 定义权威在此（config/persona/skills 引用）；机器上 agents/<id>/ 是物化态 */
  definition: string;
  homeRef: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Binding {
  bindingId: BindingId;
  tenantId: TenantId;
  platform: string;
  identity: string;
  agentId: AgentId;
  sessionPolicy: SessionPolicy;
  createdAt: number;
}

export interface Mount {
  mountId: MountId;
  tenantId: TenantId;
  consumerType: MountConsumerType;
  consumerId: string;
  sourceType: MountSourceType;
  sourceId: KnowledgeSourceId | string;
  createdAt: number;
}

export interface KnowledgeSource {
  sourceId: KnowledgeSourceId;
  scope: SourceScope;
  /** platform 库为 null */
  tenantId: TenantId | null;
  name: string;
  createdAt: number;
}
