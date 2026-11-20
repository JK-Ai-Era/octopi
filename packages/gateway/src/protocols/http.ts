/**
 * HTTP + WebSocket Channel Adapter
 *
 * - POST /messages — 发送消息（REST）
 * - GET  /health   — 健康检查
 * - WS   /ws       — WebSocket 双向流式通信
 *
 * WebSocket 协议：
 *   客户端 → 服务端:
 *     { type: "chat", content: "...", sessionId: "...", agentId: "..." }
 *     { type: "abort", sessionId: "..." }
 *
 *   服务端 → 客户端:
 *     { type: "event", event: AgentEvent }
 *     { type: "accepted", messageId: "..." }
 *     { type: "error", message: "..." }
 */

import type { ChannelAdapter, ChannelMessage, ChannelReply } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/channel-types.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import { LiveRunTracker, type LiveRunOverlay } from './live-run-tracker.js';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket, type WebSocket as WS } from 'ws';

/** timing-safe 字符串比较（防侧信道逐字节猜测 apiKey） */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface HttpAdapterOptions {
  port: number;
  /**
   * 监听 host
   *
   * 未指定时绑定 `127.0.0.1`（仅本机）。传 `0.0.0.0` 对局域网开放。
   */
  host?: string;
  path?: string;
  /** 启用 WebSocket 支持（默认 true） */
  enableWebSocket?: boolean;
  /**
   * API Key 认证
   *
   * 设置后，除公开白名单外的所有 HTTP 请求必须携带
   * Authorization: Bearer <apiKey> 头（含 onRequest 扩展路由）。
   * WebSocket 连接需要在连接后发送 auth 消息：{ type: "auth", token: "<apiKey>" }
   * 公开端点：OPTIONS 预检、GET /health。
   */
  apiKey?: string;
  /**
   * 自鉴权面：这些路径（前缀匹配）跳过本适配器的 Bearer 闸门，由 `onRequest` 侧
   * 自己的凭证闸把关（Web 向导 §7：setup token + Origin 校验）。
   *
   * 只应登记「自身已有独立凭证校验」的面——登记错了就是把该面交给下游裸奔；
   * 内置路由（/messages、/metrics）不在豁免范围内。匹配按路径段（`isSameOrSubPath`），
   * 不做裸字符串前缀匹配。
   */
  apiKeyExemptPaths?: string[];
  /**
   * 租户身份解析（§9.1-3，T4b）：auth 消息可附带 `registryToken`（registry token
   * 会话）转为租户身份连接——此后订阅受租户收口。无 registryToken = 宿主面
   * （全量可见是其正确语义）；坏凭证回 null，fail-loud 拒连。
   */
  resolveWsIdentity?: (registryToken: string) => Promise<WsTenantIdentity | null> | WsTenantIdentity | null;
  /** 订阅授权（租户身份连接的 session/agent 订阅校验；平台 admin 由实现方豁免） */
  canSubscribe?: (
    target: { sessionId?: string; agentId?: string },
    identity: WsTenantIdentity,
  ) => Promise<boolean> | boolean;
  /**
   * 允许的 CORS 源（默认 '*'）
   *
   * 生产环境应设置为具体的域名列表。
   */
  corsOrigins?: string[];
  /** JSON 请求体大小上限（字节），默认 1MB。文件上传应使用独立端点。 */
  maxBodyBytes?: number;
  onRequest?: HttpCustomRequestHandler;
  /** /health 额外字段（如 knowledge 状态） */
  healthExtras?: () => Record<string, unknown>;
}

export type HttpCustomRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;

/** WS 租户身份（auth.registryToken 解析结果） */
export interface WsTenantIdentity {
  tenantId: string;
  isPlatformAdmin: boolean;
}

interface WsSession {
  ws: WS;
  /** 是否已通过消息认证 */
  authenticated: boolean;
  /** 租户身份（auth 消息携带 registryToken 时解析；无 = 宿主面） */
  identity?: WsTenantIdentity;
  sessionId?: string;
  agentId?: string;
  /** 精确订阅的 session 列表 */
  subscribedSessions?: Set<string>;
  /** agent 维度订阅（订阅该 agent 全部会话事件；与连接身份解耦，无漂移问题） */
  subscribedAgents?: Set<string>;
  /** 发送队列（背压处理） */
  sendQueue: string[];
  /** 队列是否正在消费 */
  draining: boolean;
}

/**
 * 判断请求路径是否命中「自鉴权前缀」。
 *
 * **必须用与消费者完全相同的解析器取值**：router 用 `new URL(req.url, base).pathname`
 * 决定路由落点，此处也必须用同一化后的 `pathname` 判定。曾经用「拆 `?` + decodeURIComponent」
 * 自己解析，于是 `..\agents`（反斜杠）在 WHATWG URL 下归一化成 `/api/v1/agents`，
 * 但本函数按 '/' 拆段看不到 `..`，判定为「在豁免面内」——豁免穿到任意 /api/v1 面。
 *
 * 归一化后再按**路径段**比较：命中 `/api/v1/onboarding` 及其子路径，不命中
 * `/api/v1/onboardingX`（否则新增同前缀路径会静默继承豁免）。
 *
 * @param reqUrl - 原始 request url（含 query）
 * @param prefix - 自鉴权前缀（不含 query）
 * @returns 是否由该前缀的自鉴权面负责
 */
export function isSameOrSubPath(reqUrl: string, prefix: string): boolean {
  if (/\\|%5c/i.test(reqUrl)) return false; // 反斜杠在 WHATWG 下等同 '/'：不认豁免（fail-closed）
  let pathname: string;
  try {
    // 与 router 同一解析器；base 只用于补全，绝对路径原样保留
    pathname = new URL(reqUrl, 'http://localhost').pathname;
  } catch {
    return false; // 非法 URL：不认作豁免，走正常鉴权（fail-closed）
  }
  // 余下的 `%..` 仍需能解码：URL 不校验百分号编码，坏编码会原样留在 pathname 上。
  // 放行它会让 router 的 decodeURIComponent 抛在 try 之外（未捕获异常）——在此 fail-closed。
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Gateway 向 adapter 推送事件的接口
 */
export interface StreamingChannelAdapter extends ChannelAdapter {
  /**
   * 向指定 session 的所有 WebSocket 客户端广播事件。
   *
   * @param sessionKey - 会话键（裸 sessionId 或 `agentId:rest`；`'*'` = 系统级广播）
   * @param event - 事件本体
   * @param agentId - 事件的 agent 维度（真实 agentId，不再从 sessionKey 猜测）。
   *   缺省时回落 `event.agentId`；两者皆无则 agent 维度不命中（仅精确订阅可达）
   */
  broadcastEvent(sessionKey: string, event: AgentEvent, agentId?: string): void;
  /**
   * 在途 Run 现场快照（盲窗 overlay）；Run 不活跃返回 undefined。
   * 由消费广播的 adapter 顺手聚合（run 事件的 WS 扇出口 = 必经点）。
   */
  getLiveRun?(sessionId: string): LiveRunOverlay | undefined;
}

export class HttpChannelAdapter implements StreamingChannelAdapter {
  name = 'http';
  /** 在途 Run 现场快照（盲窗 overlay）；broadcastEvent 出口顺手聚合 */
  private readonly liveRuns = new LiveRunTracker();
  private port: number;
  private host: string;
  private path: string;
  private enableWebSocket: boolean;
  private apiKey?: string;
  private corsOrigins: string;
  private maxBodyBytes: number;
  private onRequest?: HttpCustomRequestHandler;
  private healthExtras?: () => Record<string, unknown>;
  private handler?: (msg: ChannelMessage) => Promise<void>;
  private server?: Server;
  private wss?: WebSocketServer;
  private wsSessions = new Set<WsSession>();
  /** 中止回调（由 Gateway 注册） */
  onAbort?: (sessionId: string) => void;
  /** 欢迎消息扩展（由 Gateway 注册，返回额外数据合并到欢迎消息） */
  onWelcome?: () => Record<string, unknown>;
  /** 租户身份解析（auth.registryToken → 身份，§9.1-3） */
  private readonly resolveWsIdentity?: HttpAdapterOptions['resolveWsIdentity'];
  /** 订阅授权（租户身份连接的 session/agent 订阅校验） */
  private readonly canSubscribe?: HttpAdapterOptions['canSubscribe'];
  /** 自鉴权面（前缀）：跳过本适配器 Bearer 闸，由 onRequest 侧凭证闸把关（§7 向导面） */
  private readonly apiKeyExemptPaths: string[];

  constructor(options: HttpAdapterOptions) {
    this.port = options.port;
    this.host = options.host ?? '127.0.0.1';
    this.path = options.path ?? '/messages';
    this.enableWebSocket = options.enableWebSocket ?? true;
    this.healthExtras = options.healthExtras;
    this.apiKey = options.apiKey;
    this.resolveWsIdentity = options.resolveWsIdentity;
    this.canSubscribe = options.canSubscribe;
    this.apiKeyExemptPaths = options.apiKeyExemptPaths ?? [];
    this.corsOrigins = options.corsOrigins?.join(', ') ?? '*';
    this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    this.onRequest = options.onRequest;
  }

  async start(handler: (msg: ChannelMessage) => Promise<void>): Promise<void> {
    this.handler = handler;

    this.server = createServer(async (req, res) => {
      // CORS
      res.setHeader('Access-Control-Allow-Origin', this.corsOrigins);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        // X-Registry-Token：租户身份（T4）；X-Setup-Token：Web 向导闸（§7）——跨域预检必须放行
        'Content-Type, Authorization, Accept, X-Registry-Token, X-Setup-Token',
      );

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // 公开健康检查（探针/负载均衡）；其余一律过鉴权闸门
      if (req.method === 'GET' && req.url === '/health') {
        const extra = this.healthExtras ? this.healthExtras() : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          adapter: 'http',
          websocket: this.enableWebSocket,
          connections: this.wsSessions.size,
          auth: !!this.apiKey,
          ...extra,
        }));
        return;
      }

      // 单一鉴权闸门：覆盖 onRequest 扩展（/api/v1、/debug/run…）与内置路由。
      // 禁止在下游再各自 checkAuth——那会随新路由再次漏检。
      // 例外：登记为自鉴权面的路径（apiKeyExemptPaths，如 Web 向导 §7 的 setup token 闸），
      // 由 onRequest 侧把凭证关——适配器不重复判，也不代它放行其他面。
      // 匹配按「路径段」而非裸前缀：/api/v1/onboarding 只放行它本身与其子路径，
      // 不放行 /api/v1/onboardingX 这类同前缀异路径（否则豁免会随命名扩散）。
      const selfAuth = this.apiKeyExemptPaths.some((p) => isSameOrSubPath(req.url ?? '', p));
      if (!selfAuth && !this.checkAuth(req, res)) return;

      if (this.onRequest) {
        const handled = await this.onRequest(req, res);
        if (handled) return;
      }

      if (req.method === 'GET' && req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          connections: this.wsSessions.size,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          timestamp: Date.now(),
        }));
        return;
      }

      if (req.method === 'POST' && req.url === this.path) {
        try {
          const body = await this.readBody(req);
          const message: ChannelMessage = {
            id: `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            channel: 'http',
            senderId: body.senderId ?? 'cli',
            senderName: body.senderName,
            content: body.content ?? body.message ?? '',
            conversationId: body.conversationId ?? 'default',
            timestamp: Date.now(),
            metadata: body.metadata,
          };

          this.handler!(message).catch(console.error);

          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: true, messageId: message.id }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    // WebSocket
    if (this.enableWebSocket) {
      this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
      this.wss.on('connection', (ws, req) => {
        this.handleWsConnection(ws);
      });
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => {
        this.server!.off('error', reject);
        const wsInfo = this.enableWebSocket ? ' + WebSocket /ws' : '';
        const hostInfo = this.host === '0.0.0.0' ? ' (LAN)' : ` (${this.host})`;
        console.log(`[HTTP Adapter] Listening on ${this.host}:${this.port}${hostInfo}${wsInfo}`);
        resolve();
      });
    });
  }

  async send(reply: ChannelReply): Promise<void> {
    // HTTP REST 模式的回复（非 WebSocket 客户端）
    // 广播给所有连接到该 conversationId 的 WebSocket 客户端
    const content = reply.content;
    this.broadcastToConversation(reply.conversationId, {
      type: 'reply',
      content,
      conversationId: reply.conversationId,
      replyToId: reply.replyToId,
    });
  }

  broadcastEvent(sessionKey: string, event: AgentEvent, agentId?: string): void {
    // 在途 Run 现场聚合（盲窗 overlay）：UI 可见事件必经此出口
    this.liveRuns.observe(
      String((event as { sessionId?: unknown }).sessionId ?? '') || sessionKey,
      event as unknown as { type: string; data?: Record<string, unknown>; timestamp?: number },
    );
    // sessionKey 格式：裸 sessionId（Web）或 agentId:rest（chat 通道）；'*' = 系统级广播
    const payload = { type: 'event', sessionId: sessionKey, event };
    const data = JSON.stringify(payload);
    const statePayload = this.deriveSessionState(sessionKey, event);
    const stateData = statePayload ? JSON.stringify(statePayload) : undefined;
    // agent 维度：显式 agentId（缺省回落事件自带的 agentId）；不再从 sessionKey 猜测——
    // 裸 sessionId 的 split(':')[0] 永远匹配不上连接身份（OP-WEB-1 根因）
    const eventAgentId =
      agentId ?? (typeof (event as { agentId?: unknown }).agentId === 'string'
        ? (event as { agentId: string }).agentId
        : undefined);

    for (const session of this.wsSessions) {
      if (session.ws.readyState !== WebSocket.OPEN) continue;
      // 未认证不给任何事件（含 `*` 系统级广播）：订阅/身份都来自消息面，
      // 已被未认证拒绝——这里是最后一道，别再依赖「订阅机制恰好漏不掉」
      if (!session.authenticated) continue;

      const matchesAll = sessionKey === '*';
      const matchesExact = session.subscribedSessions?.has(sessionKey) ?? false;
      // 连接身份匹配（TUI/chat 通道：chat 绑定 agentId，key 形如 agentId:rest）
      const sessionAgentId = (session.agentId ?? session.sessionId ?? '').split(':')[0];
      const matchesAgent =
        eventAgentId != null &&
        (sessionAgentId === eventAgentId || (session.subscribedAgents?.has(eventAgentId) ?? false));

      if (matchesAll || matchesExact || matchesAgent) {
        this.enqueueSend(session, data);
        if (stateData && !matchesAll) {
          this.enqueueSend(session, stateData);
        }
      }
    }
  }

  /** 在途 Run 现场快照（盲窗 overlay）；Run 不活跃返回 undefined */
  getLiveRun(sessionId: string): LiveRunOverlay | undefined {
    return this.liveRuns.get(sessionId);
  }

  private deriveSessionState(sessionKey: string, event: AgentEvent): { type: 'state'; sessionId: string; state: string } | null {
    switch (event.type) {
      case 'llm_stream_delta':
      case 'llm_thinking_delta':
      case 'model.call.start':
        return { type: 'state', sessionId: sessionKey, state: 'running' };
      case 'tool.exec.start':
      case 'tool.exec.end':
        // 工具执行 ≠ 流式输出；UI 应显示 tools 而非 streaming
        return { type: 'state', sessionId: sessionKey, state: 'tools' };
      case 'step.end': {
        // phase=pre_tools 表示工具即将执行，不能标 idle / streaming
        const phase = (event.data as { phase?: string } | undefined)?.phase;
        // step 收尾窗口（插话/followUp 可续接）不是空闲：idle 只由 engine.end 派生（评审 F4）
        return phase === 'pre_tools' ? { type: 'state', sessionId: sessionKey, state: 'tools' } : null;
      }
      case 'aborted':
        return { type: 'state', sessionId: sessionKey, state: 'aborted' };
      case 'engine.error':
      case 'model.call.error':
        return { type: 'state', sessionId: sessionKey, state: 'error' };
      case 'engine.end':
        return { type: 'state', sessionId: sessionKey, state: 'idle' };
      case 'command.result': {
        const enterLoop = (event.data as { enterLoop?: boolean } | undefined)?.enterLoop;
        // prompt 展开仍要进 Loop，不能标 idle
        return enterLoop
          ? { type: 'state', sessionId: sessionKey, state: 'running' }
          : { type: 'state', sessionId: sessionKey, state: 'idle' };
      }
      default:
        return null;
    }
  }

  /**
   * 带背压的消息入队
   *
   * 队列上限 100 条。超过时丢弃最旧的非关键消息。
   * 如果 WebSocket 缓冲区已满（bufferedAmount > 1MB），暂停入队。
   */
  private enqueueSend(session: WsSession, data: string): void {
    const MAX_QUEUE = 100;
    const MAX_BUFFER = 1024 * 1024; // 1MB

    // 高水位丢弃：丢弃队列中最旧的消息
    if (session.sendQueue.length >= MAX_QUEUE) {
      session.sendQueue.shift();
    }

    session.sendQueue.push(data);
    this.drainQueue(session);
  }

  /** 消费发送队列 */
  private drainQueue(session: WsSession): void {
    if (session.draining) return;
    session.draining = true;

    const MAX_BUFFER = 1024 * 1024; // 1MB

    const drain = () => {
      while (session.sendQueue.length > 0) {
        if (session.ws.readyState !== WebSocket.OPEN) {
          session.sendQueue.length = 0;
          break;
        }
        if (session.ws.bufferedAmount > MAX_BUFFER) {
          // 缓冲区满，延迟重试剩余消息
          setTimeout(drain, 50);
          return;
        }
        const msg = session.sendQueue.shift()!;
        session.ws.send(msg);
      }
      session.draining = false;
    };

    drain();
  }

  async stop(): Promise<void> {
    // Close all WebSocket connections
    for (const session of this.wsSessions) {
      session.ws.close();
    }
    this.wsSessions.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  // ── WebSocket handling ──

  private handleWsConnection(ws: WS): void {
    const session: WsSession = { ws, authenticated: !this.apiKey, sendQueue: [], draining: false };
    this.wsSessions.add(session);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleWsMessage(session, msg);
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      this.wsSessions.delete(session);
    });

    ws.on('error', () => {
      this.wsSessions.delete(session);
    });

    // Send welcome
    const welcome: Record<string, unknown> = {
      type: 'connected',
      message: 'Octopi Gateway WebSocket connected',
      timestamp: Date.now(),
    };
    // 合并 Gateway 提供的额外信息
    if (this.onWelcome) {
      try { Object.assign(welcome, this.onWelcome()); } catch { /* ignore */ }
    }
    ws.send(JSON.stringify(welcome));
  }

  private async handleWsMessage(session: WsSession, msg: any): Promise<void> {
    // Auth message: authenticate the session
    if (msg.type === 'auth') {
      // 租户身份（§9.1-3）：registryToken 在场就必须解析出身份，否则 fail-loud——
      // 「请求租户收口却静默落宿主全量」是提权方向，不允许（与 apiKey 闸解耦：
      // 无 apiKey 的本地部署也要守这条）
      if (typeof msg.registryToken === 'string' && msg.registryToken.trim()) {
        const identity = await this.resolveWsIdentity?.(msg.registryToken.trim()) ?? null;
        if (!identity) {
          // credential = 机器可读的失效凭据类别（客户端据此清缓存回登录，不靠文案嗅探）
          session.ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: invalid registryToken', credential: 'registryToken' }));
          session.ws.close(4001, 'Unauthorized');
          return;
        }
        session.identity = identity;
      }
      if (this.apiKey && typeof msg.token === 'string' && safeEqual(msg.token, this.apiKey)) {
        session.authenticated = true;
        session.ws.send(JSON.stringify({ type: 'auth_ok', ...(session.identity ? { tenantScoped: true } : {}) }));
      } else if (this.apiKey) {
        session.ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: invalid token', credential: 'apiKey' }));
        session.ws.close(4001, 'Unauthorized');
      }
      return;
    }

    // Reject unauthenticated messages
    if (!session.authenticated) {
      session.ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: send auth message first' }));
      return;
    }

    if (msg.type === 'chat') {
      // MAJ-4 修复：连接身份（agentId/sessionId）就是事件匹配面（matchesAgent 取
      // agentId ?? sessionId 前缀）——身份连接改写身份前必须过订阅授权，越域 chat
      // 拒收明示且不投递（防「一帧 chat 订阅他租户全部实时事件」）。
      // 无身份的宿主面连接不受此闸（apiKey 信任边界，存量语义）。
      if (session.identity) {
        const agentOk =
          msg.agentId === undefined ||
          (await this.canSubscribe?.({ agentId: String(msg.agentId) }, session.identity)) === true;
        const sessionOk =
          msg.sessionId === undefined ||
          (await this.canSubscribe?.({ sessionId: String(msg.sessionId) }, session.identity)) === true;
        if (!agentOk || !sessionOk) {
          session.ws.send(JSON.stringify({ type: 'error', message: 'Forbidden: chat target is outside your tenant' }));
          return;
        }
      }
      // 绑定 agentId（sessionId 在 Gateway 处理后更新）
      session.agentId = msg.agentId;

      const channelMsg: ChannelMessage = {
        id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channel: 'ws',
        senderId: msg.senderId ?? 'tui',
        content: msg.content ?? '',
        conversationId: msg.sessionId ?? 'default',
        timestamp: Date.now(),
        metadata: { wsSession: true, agentId: msg.agentId, sessionId: msg.sessionId, ...msg.metadata },
      };

      try {
        // Gateway 处理消息后会广播事件，广播用的是 Gateway 自己的 sessionKey
        // 但 WS session 的 sessionId 是 TUI 传来的，两者可能不一致
        // 所以先用 TUI 的 sessionId 作为 fallback
        session.sessionId = msg.sessionId;
        session.agentId = msg.agentId;
        // chat 自动订阅同过租户闸（§9.1-3）：自动加订阅=事件流入口，不能当旁路
        if (msg.sessionId) {
          const allowed =
            !session.identity ||
            (await this.canSubscribe?.({ sessionId: String(msg.sessionId) }, session.identity)) === true;
          if (allowed) {
            session.subscribedSessions ??= new Set<string>();
            session.subscribedSessions.add(String(msg.sessionId));
          }
        }
        channelMsg.onDelivery = (delivery) => {
          session.ws.send(JSON.stringify({
            type: 'accepted',
            sessionId: String(msg.sessionId ?? channelMsg.conversationId),
            messageId: channelMsg.id,
            delivery,
          }));
        };
        await this.handler!(channelMsg);
      } catch (error) {
        session.ws.send(JSON.stringify({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    } else if (msg.type === 'abort') {
      // MIN-2：中止是控制面——身份连接的 abort 同过会话归属闸（跨租户不得中止他人 run）
      if (session.identity && !(await this.canSubscribe?.({ sessionId: String(msg.sessionId) }, session.identity))) {
        session.ws.send(JSON.stringify({ type: 'error', message: `Forbidden: session ${String(msg.sessionId)} is outside your tenant` }));
        return;
      }
      console.log(`[WS] Abort requested for session ${msg.sessionId}`);
      this.onAbort?.(msg.sessionId);
    } else if (msg.type === 'subscribe' && msg.agentId && !msg.sessionId) {
      // 租户身份连接的订阅授权（§9.1-3）：agent 级订阅 = 该 agent 全部会话事件——
      // 跨租户订阅就是跨租户读流，拒收明示
      if (session.identity && !(await this.canSubscribe?.({ agentId: String(msg.agentId) }, session.identity))) {
        session.ws.send(JSON.stringify({ type: 'error', message: `Forbidden: agent ${String(msg.agentId)} is outside your tenant` }));
        return;
      }
      // agent 维度订阅：该 agent 全部会话事件。不触碰连接身份（session.agentId），
      // 从根上消除「批量订阅随列表末条漂移连接身份」的问题（OP-WEB-1）
      session.subscribedAgents ??= new Set<string>();
      session.subscribedAgents.add(String(msg.agentId));
      session.ws.send(JSON.stringify({ type: 'subscribed', agentId: String(msg.agentId) }));
    } else if (msg.type === 'unsubscribe' && msg.agentId && !msg.sessionId) {
      session.subscribedAgents?.delete(String(msg.agentId));
    } else if (msg.type === 'subscribe' && msg.sessionId) {
      // 租户身份连接的订阅授权（§9.1-3）：会话级订阅同闸
      if (session.identity && !(await this.canSubscribe?.({ sessionId: String(msg.sessionId) }, session.identity))) {
        session.ws.send(JSON.stringify({ type: 'error', message: `Forbidden: session ${String(msg.sessionId)} is outside your tenant` }));
        return;
      }
      session.subscribedSessions ??= new Set<string>();
      session.subscribedSessions.add(String(msg.sessionId));
      session.sessionId = String(msg.sessionId);
      if (msg.agentId) session.agentId = String(msg.agentId);
      // 不要在 subscribe 时注入 state=idle：
      // 切回正在跑的会话时，客户端刚从缓存恢复 tools/streaming，
      // 一条假 idle 会立刻把 UI 打回 idle。订阅只登记，不改 run 状态。
      session.ws.send(JSON.stringify({ type: 'subscribed', sessionId: String(msg.sessionId) }));
    } else if (msg.type === 'unsubscribe' && msg.sessionId) {
      session.subscribedSessions?.delete(String(msg.sessionId));
    }
  }

  private broadcastToConversation(conversationId: string, data: any): void {
    const json = JSON.stringify(data);
    for (const session of this.wsSessions) {
      if (session.sessionId === conversationId && session.ws.readyState === WebSocket.OPEN) {
        this.enqueueSend(session, json);
      }
    }
  }

  /**
   * 检查 Authorization: Bearer <apiKey> 头
   * @returns true 如果认证通过，false 如果已发送 401 响应
   */
  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.apiKey) return true;

    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!safeEqual(token, this.apiKey)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing API key' }));
      return false;
    }
    return true;
  }

  private readBody(req: any): Promise<any> {
    const maxBytes = this.maxBodyBytes;
    return new Promise((resolve, reject) => {
      let data = '';
      let totalBytes = 0;
      req.on('data', (chunk: string) => {
        totalBytes += Buffer.byteLength(chunk);
        if (totalBytes > maxBytes) {
          reject(new Error('Request body too large (limit: ' + Math.round(maxBytes / 1024) + 'KB)'));
          req.destroy();
          return;
        }
        data += chunk;
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }
}
