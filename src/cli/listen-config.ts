/**
 * Gateway HTTP 监听配置解析（纯函数；daemon / webui / TUI 接线与测试共用）
 *
 * 优先级（docs/KNOWN-ISSUES.md `gateway` 覆盖段条目，语义自 v0.98.8）：
 * CLI `--port` > `gateway.port`（进程面覆盖）> `channels[type=http].port` > 默认 18180；
 * host 同序：`gateway.host` > `channels[].host` > `web.host`（web.host 仅作缺省，
 * 局域网访问两者都要放开）。
 *
 * 语义要点：端口来源即监听开关（CLI --port / gateway.port / channels 任一存在才启动
 * 监听）；认证（apiKey）与 path 仍取 `channels[type=http]`，`gateway` 段只覆盖
 * port/host。单独 `gateway.host` 不启动监听，但渠道存在时仍改变绑定地址。
 *
 * 注意：本模块只解析对象段（channels 数组内取 type=http 一项）。
 *
 * @module
 */

import type { NetworkHostConfig } from '@octopi-agent/engine/config.js';

/** 监听 host 配置值（NetworkHostSchema：'local' | 'lan' | 具体 IP/主机名） */
export type ListenHostValue = NetworkHostConfig;

/** 监听解析输入 */
export interface ListenConfigInput {
  /** CLI `--port` */
  cliPort?: number;
  /** `gateway` 进程面覆盖段 */
  gateway?: { port?: number; host?: ListenHostValue };
  /** `channels[type=http]` 段 */
  http?: { port?: number; host?: ListenHostValue };
  /** `web.host`（仅作 host 缺省） */
  webHost?: ListenHostValue;
}

/** 监听解析结果 */
export interface ListenConfig {
  /** 生效监听端口（enabled=false 时为缺省值，不作数） */
  port: number;
  /** 生效 host 配置值（undefined = 由 resolveListenHost 决定缺省） */
  host?: ListenHostValue;
  /** 是否启动 HTTP 监听（存在显式端口来源：CLI / gateway / channels） */
  enabled: boolean;
}

/**
 * 解析 Gateway HTTP 监听配置
 *
 * @param input - 各来源配置
 * @returns 监听配置（端口/host/是否启动）
 */
export function resolveListenConfig(input: ListenConfigInput): ListenConfig {
  const port = input.cliPort ?? input.gateway?.port ?? input.http?.port ?? 18180;
  const host = input.gateway?.host ?? input.http?.host ?? input.webHost;
  const enabled = input.cliPort != null || input.gateway?.port != null || input.http != null;
  return { port, host, enabled };
}
