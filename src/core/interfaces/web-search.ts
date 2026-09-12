/**
 * WebSearchProvider — 网络搜索接口
 *
 * 职责：执行网页搜索并返回归一化结果。
 * 实现方：DuckDuckGo、Tavily、Brave、Serper 等外部搜索 API。
 *
 * 设计要点：
 * - Core 只定义契约，不关心 HTTP / 鉴权细节
 * - Harness 的 web_search 工具通过依赖注入接收实现
 * - Integration 层提供具体 adapter
 */

// ── 请求/响应类型 ──

/** 单条搜索结果 */
export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  /** 发布时间（ISO 8601，provider 可选支持） */
  publishedAt?: string;
  /** 结果排序（1-based） */
  rank?: number;
}

/** 搜索选项 */
export interface WebSearchOptions {
  /** 最大结果数（默认 5） */
  limit?: number;
  /** 地区/语言，如 "cn-zh"、"us-en" */
  region?: string;
  /** 安全搜索级别 */
  safeSearch?: 'off' | 'moderate' | 'strict';
  /** 时间范围过滤 */
  timeRange?: 'day' | 'week' | 'month' | 'year';
  /** 外部取消信号 */
  signal?: AbortSignal;
}

/** 搜索响应 */
export interface WebSearchResponse {
  query: string;
  /** 实际提供结果的 provider id */
  provider: string;
  results: WebSearchResultItem[];
  /** 原始命中总数（provider 可选上报） */
  total?: number;
  /** LLM 类搜索源可选返回的综合摘要（如 MiMo 联网搜索正文） */
  answer?: string;
}

// ── 接口定义 ──

/**
 * WebSearchProvider 接口
 *
 * 实现方必须提供：
 * - search(): 执行搜索并返回归一化结果
 */
export interface WebSearchProvider {
  /** Provider 标识（配置 key / 日志用） */
  readonly id: string;
  /** 人类可读名称 */
  readonly name: string;

  /**
   * 执行搜索
   *
   * @param query - 搜索关键词
   * @param options - 可选过滤条件
   * @returns 归一化搜索结果
   * @throws 网络错误、鉴权失败、限流时抛出
   */
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResponse>;
}
