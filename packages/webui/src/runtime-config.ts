/**
 * WebUI 运行时配置读取（`/octopi-config.js` → `window.__OCTOPI_WEB__`）。
 *
 * 与 gateway-base 的回源地址解析分开：这里只管 UI 行为旋钮（Git 页签轮询
 * 频率等），真相源是 octopi.json 的 `web.*` 段，serve-webui 启动时下发；
 * 缺省走内置默认。
 *
 * 边界镜像：浏览器包引不到 suite，本文件的校验/默认值与
 * `src/config-schema/webui.ts` 的 `isValidGitStatusPollSeconds` /
 * `DEFAULT_GIT_STATUS_POLL_SECONDS` 是同一契约的手工镜像，改边界两处同改。
 */

/** serve-webui 启动时注入的 UI 配置（`window.__OCTOPI_WEB__`） */
declare global {
  interface Window {
    __OCTOPI_WEB__?: { gitStatusPollSeconds?: number } | null;
  }
}

/** 无运行时下发时的 Git 页签轮询间隔（秒） */
const DEFAULT_GIT_STATUS_POLL_SECONDS = 5;

/**
 * Git 页签轮询间隔（秒）。0 = 仅手动刷新。
 *
 * @returns 校验后的配置值；下发缺失/非法时回退默认 5s
 */
export function getGitStatusPollSeconds(): number {
  const v = typeof window !== 'undefined' ? window.__OCTOPI_WEB__?.gitStatusPollSeconds : undefined;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3600
    ? v
    : DEFAULT_GIT_STATUS_POLL_SECONDS;
}
