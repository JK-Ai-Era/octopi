/**
 * HTTP 查询参数解析（纯函数叶子模块）
 *
 * API 路由（http-app）与纯读路由（read-http）共用；刻意不依赖 query-service
 * 实现，避免 HTTP 层反向依赖服务层。
 *
 * @module harness/knowledge/http-params
 */

/**
 * 解析 promotion 候选阈值查询参数（非法值忽略，回落 hit-log 默认 3/10）。
 *
 * @param searchParams - URL 查询参数（`minSessions` / `minHits`）
 * @returns 有效阈值；未配置或非法的键不出现
 */
export function promotionThresholdsFromParams(
  searchParams: URLSearchParams,
): { minSessions?: number; minHits?: number } {
  const out: { minSessions?: number; minHits?: number } = {};
  const minSessions = Number(searchParams.get('minSessions'));
  if (Number.isFinite(minSessions) && minSessions > 0) out.minSessions = Math.floor(minSessions);
  const minHits = Number(searchParams.get('minHits'));
  if (Number.isFinite(minHits) && minHits > 0) out.minHits = Math.floor(minHits);
  return out;
}
