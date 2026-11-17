/**
 * 租户闸（arch/multi-tenancy.md §6：命中 = 挂载库 ∪ 本租户公共 ∪ platform 公共）。
 *
 * 单源两形态：本模块同时导出内存判定与 SQL 谓词，二者必须逐格等价
 * （tests/harness/knowledge-tenant-gate.test.ts 固化）。所有读路径改用本模块，
 * 禁止再手写 `tenant_id = ?` 硬等值——platform 域（broker 全量视图）会被硬等值清空
 * （MAJ-4 遗留：管理面读口租户闸）。
 *
 * 语义（三闸各司其职，勿混用）：
 * - `tenantGate*`   租户域闸：platform=全量；行无归属=可见；platform 行=对全租户可见；其余=本域。
 * - `ownerFunnel*`  归属漏斗（**只属于源**）：registered_by=己方 ∪ visibility='public'。
 *                   项目**不**走漏斗：同租户跨网关共享项目是既定设计
 *                   （tests/harness/knowledge-cross-gateway.test.ts「catalog/挂载同口径」）。
 * - `projectGate*`  项目跨域闸：本域项目可见；platform 项目仅 visibility='public' 才跨域可见。
 *
 * 无身份（identity === undefined）= 宿主面 = 不设闸（与 listSources/getSource 既有语义一致）。
 */
import { DEFAULT_TENANT_ID, PLATFORM_TENANT_ID } from '@octopi-agent/core/types.js';

/** 闸身份：缺省字段按 DEFAULT 域（fail-closed，评审 MAJ-2）解析。 */
export interface GateIdentity {
  tenantId?: string;
  gatewayId?: string;
}

/** SQL 谓词片段：`sql` 直接拼接进 WHERE，`params` 按序绑定。 */
export interface GateSql {
  sql: string;
  params: string[];
}

/** 解析读身份的租户域；无身份返回 null（宿主面，不设闸）。 */
function tenantOf(identity: GateIdentity | undefined): string | null {
  if (identity === undefined) return null;
  return identity.tenantId ?? DEFAULT_TENANT_ID;
}

/**
 * 租户域闸（内存形态）。
 *
 * @param rowTenant 行归属租户（来源行的 tenant_id）；空值视为无归属（可见）
 * @param identity 读身份；undefined = 宿主面（不设闸）
 * @returns 行是否落在该身份的可见域内
 */
export function tenantGateAllows(
  rowTenant: string | undefined | null,
  identity?: GateIdentity,
): boolean {
  const tenant = tenantOf(identity);
  if (tenant === null || tenant === PLATFORM_TENANT_ID) return true;
  if (!rowTenant) return true;
  if (rowTenant === PLATFORM_TENANT_ID) return true;
  return rowTenant === tenant;
}

/**
 * 租户域闸（SQL 形态；与 {@link tenantGateAllows} 逐格等价）。
 *
 * @param column tenant_id 列名（可带表别名前缀）
 * @param identity 读身份；undefined = 宿主面（不设闸）
 * @returns 可拼接的 WHERE 谓词与绑定参数
 */
export function tenantGateSql(column = 'tenant_id', identity?: GateIdentity): GateSql {
  const tenant = tenantOf(identity);
  if (tenant === null || tenant === PLATFORM_TENANT_ID) return { sql: '1 = 1', params: [] };
  return {
    sql: `(IFNULL(${column}, '') = '' OR ${column} = ? OR ${column} = ?)`,
    params: [tenant, PLATFORM_TENANT_ID],
  };
}

/**
 * 本域闸（内存形态）——用于**写入物**（agent/session 覆盖行、挂载行、主体行）：
 * 这类行按域归属隔离，platform 行**不**自动扩散到租户（与资产闸 {@link tenantGateAllows}
 * 的「platform=公共」语义有意不同：覆盖行扩散=平台行悄悄操纵他租户 agent 可见性）；
 * 仅 platform 读身份（broker 运维面）= 全量。
 *
 * @param rowTenant 行归属租户；空值视为无归属（可见）
 * @param identity 读身份；undefined = 宿主面（不设闸）
 */
export function tenantOwnGateAllows(
  rowTenant: string | undefined | null,
  identity?: GateIdentity,
): boolean {
  const tenant = tenantOf(identity);
  if (tenant === null || tenant === PLATFORM_TENANT_ID) return true;
  if (!rowTenant) return true;
  return rowTenant === tenant;
}

/** 本域闸（SQL 形态；与 {@link tenantOwnGateAllows} 逐格等价） */
export function tenantOwnGateSql(column = 'tenant_id', identity?: GateIdentity): GateSql {
  const tenant = tenantOf(identity);
  if (tenant === null || tenant === PLATFORM_TENANT_ID) return { sql: '1 = 1', params: [] };
  return {
    sql: `(IFNULL(${column}, '') = '' OR ${column} = ?)`,
    params: [tenant],
  };
}

/**
 * 单行读取的确定性排序（同 (gateway, agent/session, target) 可在多域各有一行，
 * `.get()` 无序返回任意行会让可见性判定漂移）：本域行优先，其次 platform 行，再按域名字典序。
 */
export function tenantPrecedenceOrder(
  column = 'tenant_id',
  identity?: GateIdentity,
): GateSql {
  const tenant = tenantOf(identity) ?? '';
  return {
    sql: `CASE WHEN IFNULL(${column}, '') = ? THEN 0 WHEN ${column} = ? THEN 1 ELSE 2 END, ${column}`,
    params: [tenant, PLATFORM_TENANT_ID],
  };
}

/**
 * 归属漏斗（内存形态；只用于源）。
 *
 * @param rowRegisteredBy 行登记网关（registered_by）
 * @param rowVisibility 行可见性（'public' | 'private'）
 * @param identity 读身份；undefined = 宿主面（不设闸）；无 gatewayId = 不设漏斗
 * @returns 行是否通过归属漏斗
 */
export function ownerFunnelAllows(
  rowRegisteredBy: string | undefined | null,
  rowVisibility: string | undefined | null,
  identity?: GateIdentity,
): boolean {
  if (identity === undefined) return true;
  const gw = identity.gatewayId;
  if (!gw) return true;
  if (!rowRegisteredBy || rowRegisteredBy === gw) return true;
  return rowVisibility === 'public';
}

/**
 * 归属漏斗（SQL 形态；与 {@link ownerFunnelAllows} 逐格等价）。
 *
 * @param registeredByColumn registered_by 列名（可带表别名前缀）
 * @param visibilityColumn visibility 列名（可带表别名前缀）
 * @param identity 读身份；undefined = 宿主面（不设闸）；无 gatewayId = 不设漏斗
 * @returns 可拼接的 WHERE 谓词与绑定参数
 */
export function ownerFunnelSql(
  registeredByColumn = 'registered_by',
  visibilityColumn = 'visibility',
  identity?: GateIdentity,
): GateSql {
  if (identity === undefined || !identity.gatewayId) return { sql: '1 = 1', params: [] };
  return {
    sql: `(IFNULL(${registeredByColumn}, '') = '' OR ${registeredByColumn} = ? OR ${visibilityColumn} = 'public')`,
    params: [identity.gatewayId],
  };
}

/**
 * 项目跨域闸（内存形态）：本域项目（含无归属）始终可见；platform 项目仅
 * `visibility='public'` 才对租户可见（跨租户共享唯一合法形态 = platform 公共，
 * arch/multi-tenancy.md §6）；platform 身份 = 全量视图。
 *
 * @param rowTenant 项目行归属租户
 * @param rowVisibility 项目行可见性（'public' | 'private'）
 * @param identity 读身份；undefined = 宿主面（不设闸）
 * @returns 项目行是否对该身份可见
 */
export function projectGateAllows(
  rowTenant: string | undefined | null,
  rowVisibility: string | undefined | null,
  identity?: GateIdentity,
): boolean {
  const tenant = tenantOf(identity);
  if (tenant === null || tenant === PLATFORM_TENANT_ID) return true;
  if (!rowTenant) return true;
  if (rowTenant === PLATFORM_TENANT_ID) return rowVisibility === 'public';
  return rowTenant === tenant;
}

/**
 * 项目跨域闸（SQL 形态；与 {@link projectGateAllows} 逐格等价）。
 *
 * @param tenantColumn tenant_id 列名（可带表别名前缀）
 * @param visibilityColumn visibility 列名（可带表别名前缀）
 * @param identity 读身份；undefined = 宿主面（不设闸）
 * @returns 可拼接的 WHERE 谓词与绑定参数
 */
export function projectGateSql(
  tenantColumn = 'tenant_id',
  visibilityColumn = 'visibility',
  identity?: GateIdentity,
): GateSql {
  const tenant = tenantOf(identity);
  if (tenant === null || tenant === PLATFORM_TENANT_ID) return { sql: '1 = 1', params: [] };
  return {
    sql:
      `(IFNULL(${tenantColumn}, '') = '' OR ${tenantColumn} = ?` +
      ` OR (${tenantColumn} = ? AND ${visibilityColumn} = 'public'))`,
    params: [tenant, PLATFORM_TENANT_ID],
  };
}
