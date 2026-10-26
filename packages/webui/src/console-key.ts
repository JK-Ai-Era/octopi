/**
 * WebUI 控制台凭据（Gateway `channels.http.apiKey`）单一来源 + 本机持久化。
 *
 * 背景：apiKey 曾只活在 ChatWorkspace 的 `useState`——组件卸载即蒸发（切页签
 * 回来要重填），且各 Settings 面板自建 keyless client（开鉴权后全线 401）。
 * 此处收口：模块级来源 + localStorage，所有 `OctopiClient` 构造统一从这里取。
 *
 * 安全口径（诚实声明）：localStorage 对同源脚本可读——控制台会渲染 agent
 * 产出的 markdown，XSS 面真实存在。这是 LAN 个人控制台的易用性取舍；
 * 钥匙离开本机（换浏览器/清站点数据）需重填，不做跨端同步。
 */

const STORAGE_KEY = 'octopi.console.apiKey';

/** 内存态：存储不可用（隐私模式/配额）时的退化载体 */
let memoryKey = '';

/**
 * 读取控制台钥匙（内存态优先，其次 localStorage）。
 *
 * @returns 钥匙字符串；未配置时为空串
 */
export function getConsoleKey(): string {
  if (memoryKey) return memoryKey;
  try {
    memoryKey = window.localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    memoryKey = '';
  }
  return memoryKey;
}

/**
 * 写入控制台钥匙（内存 + localStorage）。空串 = 清除。
 * 存储写失败时退化为内存态，不假装已持久化。
 *
 * @param key - Gateway apiKey（非 LLM key）
 */
export function setConsoleKey(key: string): void {
  memoryKey = key;
  try {
    if (key) {
      window.localStorage.setItem(STORAGE_KEY, key);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // 存储不可用：内存态兜底，刷新后需重填
  }
}
