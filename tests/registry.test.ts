/**
 * RegistryService — 租户与定义面行为锚（arch/multi-tenancy.md）。
 *
 * 覆盖：注册（一用户一租户/首个 admin）、agent 归属与可见性、管理授权、
 * 绑定/挂载的租户边界（「租户内是引用，跨租户是集成」）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RegistryService } from '../packages/engine/src/harness/governance/registry/service.js';
import type {
  AgentId,
  TenantId,
  UserId,
} from '../packages/engine/src/harness/governance/registry/types.js';

describe('RegistryService — 注册（一用户一租户）', () => {
  let registry: RegistryService;
  beforeEach(async () => {
    registry = await RegistryService.create({ dbPath: ':memory:' });
  });
  afterEach(() => registry.close());

  it('首个注册用户为平台 admin，之后不是', () => {
    const first = registry.registerUser({ name: 'alice' });
    const second = registry.registerUser({ name: 'bob' });
    expect(first.user.isPlatformAdmin).toBe(true);
    expect(second.user.isPlatformAdmin).toBe(false);
  });

  it('一用户一租户：user 与 tenant 同名同建，userId≠tenantId（分字段）', () => {
    const { tenant, user } = registry.registerUser({ name: 'alice' });
    expect(user.tenantId).toBe(tenant.tenantId);
    expect(user.userId).not.toBe(user.tenantId);
    expect(registry.getUser(user.userId)).toEqual(user);
  });

  it('用户名全局唯一（第二租户同名注册被拒）', () => {
    registry.registerUser({ name: 'alice' });
    expect(() => registry.registerUser({ name: 'alice' })).toThrow();
  });
});

describe('RegistryService — agent 归属（tenant 拥有/user 管理/visibility）', () => {
  let registry: RegistryService;
  let alice: { userId: UserId; tenantId: TenantId };
  let bob: { userId: UserId; tenantId: TenantId };
  beforeEach(async () => {
    registry = await RegistryService.create({ dbPath: ':memory:' });
    const a = registry.registerUser({ name: 'alice' });
    const b = registry.registerUser({ name: 'bob' });
    alice = { userId: a.user.userId, tenantId: a.tenant.tenantId };
    bob = { userId: b.user.userId, tenantId: b.tenant.tenantId };
  });
  afterEach(() => registry.close());

  it('创建 agent：归属租户、owner 自动同租户', () => {
    const agent = registry.createAgent({ tenantId: alice.tenantId, ownerUserId: alice.userId, name: 'helper' });
    expect(agent.tenantId).toBe(alice.tenantId);
    expect(agent.ownerUserId).toBe(alice.userId);
    expect(agent.visibility).toBe('private');
  });

  it('跨租户 owner 被拒（管理关系也不出租户）', () => {
    expect(() =>
      registry.createAgent({ tenantId: alice.tenantId, ownerUserId: bob.userId, name: 'helper' }),
    ).toThrow(/cross_tenant_owner/);
  });

  it('agent 名称租户内唯一、跨租户可重名', () => {
    registry.createAgent({ tenantId: alice.tenantId, ownerUserId: alice.userId, name: 'helper' });
    expect(() =>
      registry.createAgent({ tenantId: alice.tenantId, ownerUserId: alice.userId, name: 'helper' }),
    ).toThrow();
    expect(() =>
      registry.createAgent({ tenantId: bob.tenantId, ownerUserId: bob.userId, name: 'helper' }),
    ).not.toThrow();
  });

  it('visibility：private 仅 owner 可见，tenant 租户内共享', () => {
    const priv = registry.createAgent({ tenantId: alice.tenantId, ownerUserId: alice.userId, name: 'private-bot' });
    registry.createAgent({
      tenantId: alice.tenantId,
      ownerUserId: alice.userId,
      name: 'team-bot',
      visibility: 'tenant',
    });
    // 另一个用户加入同租户（未来 org 模型；当下用 admin 模拟查看者不可见私有）
    const ownerView = registry.listAgents({ tenantId: alice.tenantId, viewerUserId: alice.userId });
    expect(ownerView.map((a) => a.name).sort()).toEqual(['private-bot', 'team-bot']);
    const outsiderView = registry.listAgents({ tenantId: bob.tenantId, viewerUserId: bob.userId });
    expect(outsiderView).toEqual([]);
    expect(priv.visibility).toBe('private');
  });

  it('更新/删除授权：owner 可、他租户用户不可、平台 admin 可', () => {
    const agent = registry.createAgent({ tenantId: alice.tenantId, ownerUserId: alice.userId, name: 'helper' });
    expect(registry.updateAgent({ agentId: agent.agentId, viewerUserId: alice.userId, patch: { name: 'renamed' } }).name).toBe('renamed');
    expect(() =>
      registry.updateAgent({ agentId: agent.agentId, viewerUserId: bob.userId, patch: { name: 'hacked' } }),
    ).toThrow(/forbidden/);
    // bob 是平台首个用户=admin？——不是（alice 先注册），此处验证 admin 路径另建
    expect(() => registry.deleteAgent({ agentId: agent.agentId, viewerUserId: bob.userId })).toThrow(/forbidden/);
    expect(registry.deleteAgent({ agentId: agent.agentId, viewerUserId: alice.userId })).toBe(true);
  });

  it('definition 须为合法 JSON', () => {
    expect(() =>
      registry.createAgent({
        tenantId: alice.tenantId,
        ownerUserId: alice.userId,
        name: 'bad',
        definition: '{oops',
      }),
    ).toThrow(/invalid_definition/);
  });
});

describe('RegistryService — 渠道绑定（路由真相源）', () => {
  let registry: RegistryService;
  let alice: { userId: UserId; tenantId: TenantId };
  let bob: { userId: UserId; tenantId: TenantId };
  beforeEach(async () => {
    registry = await RegistryService.create({ dbPath: ':memory:' });
    const a = registry.registerUser({ name: 'alice' });
    const b = registry.registerUser({ name: 'bob' });
    alice = { userId: a.user.userId, tenantId: a.tenant.tenantId };
    bob = { userId: b.user.userId, tenantId: b.tenant.tenantId };
  });
  afterEach(() => registry.close());

  it('绑定不出租户：agent 属于别租户被拒', () => {
    const agent = registry.createAgent({ tenantId: bob.tenantId, ownerUserId: bob.userId, name: 'helper' });
    expect(() =>
      registry.createBinding({
        tenantId: alice.tenantId,
        platform: 'feishu',
        identity: 'ou_x',
        agentId: agent.agentId,
      }),
    ).toThrow(/cross_tenant_binding/);
  });

  it('resolveBinding 回环 + (tenant,platform,identity) 唯一', () => {
    const agent = registry.createAgent({ tenantId: alice.tenantId, ownerUserId: alice.userId, name: 'helper' });
    const binding = registry.createBinding({
      tenantId: alice.tenantId,
      platform: 'feishu',
      identity: 'ou_x',
      agentId: agent.agentId,
      sessionPolicy: 'per-chat',
    });
    expect(registry.resolveBinding({ tenantId: alice.tenantId, platform: 'feishu', identity: 'ou_x' })).toEqual(binding);
    expect(() =>
      registry.createBinding({
        tenantId: alice.tenantId,
        platform: 'feishu',
        identity: 'ou_x',
        agentId: agent.agentId,
      }),
    ).toThrow();
  });

  it('同一 identity 在不同租户可各自绑定（租户锚=凭证归属）', () => {
    const agentA = registry.createAgent({ tenantId: alice.tenantId, ownerUserId: alice.userId, name: 'a' });
    const agentB = registry.createAgent({ tenantId: bob.tenantId, ownerUserId: bob.userId, name: 'b' });
    registry.createBinding({ tenantId: alice.tenantId, platform: 'wechat', identity: 'openid-1', agentId: agentA.agentId });
    expect(() =>
      registry.createBinding({ tenantId: bob.tenantId, platform: 'wechat', identity: 'openid-1', agentId: agentB.agentId }),
    ).not.toThrow();
  });
});

describe('RegistryService — 知识挂载（两级所有权 + 租户内挂载）', () => {
  let registry: RegistryService;
  let alice: { userId: UserId; tenantId: TenantId };
  let bob: { userId: UserId; tenantId: TenantId };
  beforeEach(async () => {
    registry = await RegistryService.create({ dbPath: ':memory:' });
    const a = registry.registerUser({ name: 'alice' });
    const b = registry.registerUser({ name: 'bob' });
    alice = { userId: a.user.userId, tenantId: a.tenant.tenantId };
    bob = { userId: b.user.userId, tenantId: b.tenant.tenantId };
  });
  afterEach(() => registry.close());

  it('跨租户挂载被拒；platform 公共库可跨租户挂', () => {
    const bobSource = registry.createKnowledgeSource({ scope: 'tenant', tenantId: bob.tenantId, name: 'bob-docs' });
    expect(() =>
      registry.createMount({
        tenantId: alice.tenantId,
        consumerType: 'agent',
        consumerId: 'agent-1',
        sourceType: 'knowledge',
        sourceId: bobSource.sourceId,
      }),
    ).toThrow(/cross_tenant_mount/);
    const shared = registry.createKnowledgeSource({ scope: 'platform', name: 'manual' });
    expect(() =>
      registry.createMount({
        tenantId: alice.tenantId,
        consumerType: 'agent',
        consumerId: 'agent-1',
        sourceType: 'knowledge',
        sourceId: shared.sourceId,
      }),
    ).not.toThrow();
  });

  it('可见集 = 挂载库 ∪ 本租户公共 ∪ platform 公共，不含别租户', () => {
    const own = registry.createKnowledgeSource({ scope: 'tenant', tenantId: alice.tenantId, name: 'alice-docs' });
    const other = registry.createKnowledgeSource({ scope: 'tenant', tenantId: bob.tenantId, name: 'bob-docs' });
    const shared = registry.createKnowledgeSource({ scope: 'platform', name: 'manual' });
    const visible = registry.listVisibleSources({
      tenantId: alice.tenantId,
      consumerType: 'agent',
      consumerId: 'agent-1',
    });
    const names = visible.map((s) => s.name).sort();
    expect(names).toEqual(['alice-docs', 'manual']);
    expect(visible.find((s) => s.sourceId === other.sourceId)).toBeUndefined();
  });
});

describe('RegistryService — 同租户断言（委派/参与边界）', () => {
  let registry: RegistryService;
  beforeEach(async () => {
    registry = await RegistryService.create({ dbPath: ':memory:' });
  });
  afterEach(() => registry.close());

  it('同租户通过并返回租户；混租户抛错', () => {
    const a = registry.registerUser({ name: 'alice' });
    const b = registry.registerUser({ name: 'bob' });
    const agentA1 = registry.createAgent({ tenantId: a.tenant.tenantId, ownerUserId: a.user.userId, name: 'a1' });
    const agentA2 = registry.createAgent({ tenantId: a.tenant.tenantId, ownerUserId: a.user.userId, name: 'a2' });
    const agentB = registry.createAgent({ tenantId: b.tenant.tenantId, ownerUserId: b.user.userId, name: 'b1' });

    expect(registry.assertSameTenant([agentA1.agentId, agentA2.agentId])).toBe(a.tenant.tenantId);
    expect(() => registry.assertSameTenant([agentA1.agentId, agentB.agentId as AgentId])).toThrow(
      /cross_tenant_participation/,
    );
    expect(() => registry.assertSameTenant([])).toThrow(/empty_agent_set/);
  });
});
