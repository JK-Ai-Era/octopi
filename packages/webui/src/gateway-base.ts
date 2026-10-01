/**
 * WebUI → Gateway 回源地址解析（三处组件共用，勿复制）。
 *
 * 优先级：构建期 env `VITE_OCTOPI_BASE` > 运行时下发（`/octopi-config.js`，
 * serve-webui 按 octopi.json 生成） > 默认 18180。
 *
 * 协议策略：https 页面（反向代理终结 TLS）走同源——网关原生只说 http，
 * 代理必须同时转发 /health、/messages、/ws、/api/v1；http 页面用
 * hostname + 下发端口直连。需要非同源的特例用 VITE_OCTOPI_BASE 覆盖。
 */

/** serve-webui 启动时注入的运行时配置（`window.__OCTOPI_GATEWAY__`） */
declare global {
  interface Window {
    __OCTOPI_GATEWAY__?: { port?: number } | null;
  }
}

const FALLBACK_PORT = 18180;

function isValidPort(port: number | undefined): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** 解析 Gateway base URL（无尾斜杠） */
export function resolveDefaultBase(): string {
  const fromEnv = (import.meta.env.VITE_OCTOPI_BASE as string | undefined)?.replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  if (typeof window !== 'undefined' && window.location?.hostname) {
    const { protocol, hostname, host } = window.location;
    if (protocol === 'https:') return `${protocol}//${host}`;
    const injected = isValidPort(window.__OCTOPI_GATEWAY__?.port)
      ? window.__OCTOPI_GATEWAY__!.port!
      : FALLBACK_PORT;
    return `${protocol}//${hostname}:${injected}`;
  }
  return `http://localhost:${FALLBACK_PORT}`;
}
