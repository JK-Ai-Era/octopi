/**
 * LLM Wire Dump — 把 provider 实际发送的请求体按 session 落盘
 *
 * 目的：前缀缓存是否命中，只取决于「本次请求输入前缀 vs 上一次请求」的逐字节一致性。
 * 现有观测（Observer `context.llm`）只能看到 ContextEngine 出口的 role/content 视图，
 * 既不含 tools，也不含 provider 侧变换（Anthropic system 提升、OpenAI sanitize/flatten），
 * 因此无法回答「前缀到底在哪一条消息、哪个字节断开」。
 *
 * 落盘形态（每个调用两份）：
 * - `<dir>/<session>/<id>.json`  —— 完整请求体（wire body，逐字节同实际发送）
 * - `<dir>/<session>/index.jsonl` —— 轻量索引（每消息 hash/长度 + toolsHash + 结果/usage）
 *
 * 设计约束：
 * - 默认关闭（写盘量按请求体 × 调用次数计，长 session 可能很大）。
 * - 写入串行排队且不阻塞调用方（fire-and-forget）；`flush()` 供测试/优雅退出等待。
 * - 每 session 环形上限 `maxCallsPerSession`：超出后删除最旧的 body 文件并压缩索引。
 *
 * @module integration/providers/wire-dump
 */

import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TokenUsage } from '@octopi-agent/core/types/turn.js';
import type { LLMRequest, ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import { getOctopiHome } from '../../paths.js';
import {
  readHttpStatus,
  readStreamDiag,
} from './provider-diagnostics.js';
import { readAttemptBudgetExhausted } from '../../harness/run/reliability/fallback-provider.js';

/** 调用方身份（由 harness 侧解析，integration 不反向依赖 harness） */
export interface WireDumpContext {
  sessionId?: string;
  agentId?: string;
  runId?: string;
}

/**
 * 落盘配置（纯数据，可出现在 `octopi.json`）
 *
 * 不含 `resolveContext` 等运行时钩子：配置面只表达「写到哪、写多少」，
 * 钩子只能由代码在构造 sink 时注入。
 */
export interface WireDumpConfig {
  /** 是否启用（缺省关闭；CLI daemon 按此开关构造 sink） */
  enabled?: boolean;
  /** 落盘根目录；缺省 `<OCTOPI_HOME>/logs/llm-requests` */
  dir?: string;
  /** 每 session 保留的调用条数（环形，缺省 200） */
  maxCallsPerSession?: number;
  /** 单次请求体落盘上限（字节，缺省 8_000_000）；超出则只写索引 */
  maxBodyBytes?: number;
}

/** sink 构造选项 = 配置 + 运行时身份解析 */
export interface WireDumpHookOptions extends WireDumpConfig {
  /** 调用瞬间解析当前 run 身份 */
  resolveContext?: () => WireDumpContext | undefined;
}

/** 一次捕获的输入（provider 侧已构造完毕的 wire body） */
export interface WireCaptureInput {
  provider: string;
  model: string;
  mode: 'chat' | 'stream';
  body: Record<string, unknown>;
}

/** 调用收尾信息 */
export interface WireCallResult {
  outcome: 'ok' | 'error' | 'abandoned';
  usage?: TokenUsage;
  /** 首个 chunk 到达耗时（仅 stream） */
  ttftMs?: number;
  durationMs: number;
  /** 失败原因（仅 error；由包装层从错误对象提取，观测专用） */
  error?: WireCallErrorInfo;
}

/**
 * 失败留痕
 *
 * 此前 result 记录只有 `outcome: 'error'`，一次 52 分钟停滞只能靠耗时反推原因。
 * 这里补上错误类型、消息、HTTP 状态码与流内心跳计数，使「上游静默」可被直接读出。
 */
export interface WireCallErrorInfo {
  /** 错误构造器名（TypeError / Error / AbortError …） */
  name?: string;
  /** 错误消息（截断，避免超长响应体撑爆索引） */
  message: string;
  /** 上游 HTTP 状态码（非 2xx 时由 provider 附加） */
  httpStatus?: number;
  /** 系统错误码（ECONNRESET / UND_ERR_SOCKET …） */
  code?: string;
  /** 流内保活心跳数：>0 表示上游连接活着但未产出内容 */
  keepalives?: number;
  /** 流内已产出的内容 chunk 数 */
  contentChunks?: number;
  /** 流内已读取字节数 */
  streamBytes?: number;
  /** 首个 wire 字节到达时刻（epoch ms）：区分「首包前静默」与「中段断流」 */
  firstBytesAt?: number;
  /** 最后一个 wire 字节到达时刻（epoch ms）：回答「被掐前 wire 到底动没动」 */
  lastBytesAt?: number;
  /** 是否读到协议终止（done / EOF） */
  sawEnd?: boolean;
  /** 回退链单节点预算耗尽时的预算值（毫秒）；存在即「节点只是慢」，非用户取消 */
  attemptBudgetMs?: number;
}

/** 单次调用的收尾句柄 */
export interface WireCallHandle {
  id: string;
  finish(result: WireCallResult): void;
}

/** provider 侧依赖的唯一接口 */
export interface WireDumpSink {
  capture(input: WireCaptureInput): WireCallHandle | undefined;
  /** 等待已排队写入落地 */
  flush(): Promise<void>;
}

/** 索引中的前缀单元（与 provider wire 消息一一对应） */
interface WireUnit {
  role: string;
  /** 该单元 JSON 序列化后的 UTF-16 字符数（与 `WirePrefixDiff.stableChars` 同单位） */
  len: number;
  /** 该单元 JSON 序列化后的短 hash */
  hash: string;
}

/** index.jsonl 的 request 行 */
export interface WireDumpRequestRecord {
  type: 'request';
  id: string;
  at: number;
  n: number;
  sessionId?: string;
  agentId?: string;
  runId?: string;
  provider: string;
  model: string;
  mode: 'chat' | 'stream';
  msgCount: number;
  chars: number;
  bodyBytes: number;
  /** 超出 maxBodyBytes：body 未落盘 */
  oversize: boolean;
  toolCount: number;
  toolsHash: string;
  roles: string[];
  lens: number[];
  hashes: string[];
  file?: string;
}

/** index.jsonl 的 result 行 */
export interface WireDumpResultRecord {
  type: 'result';
  id: string;
  at: number;
  outcome: 'ok' | 'error' | 'abandoned';
  durationMs: number;
  ttftMs?: number;
  error?: WireCallErrorInfo;
  usage?: {
    inputCachedTokens: number;
    inputUncachedTokens: number;
    inputCacheWriteTokens: number;
    inputReportedTokens?: number;
    outputTokens: number;
    cacheAware: boolean;
  };
}

export type WireDumpIndexRecord = WireDumpRequestRecord | WireDumpResultRecord;

/** 错误消息落盘上限（字符）：上游错误体可能带整段响应，撑爆索引无意义 */
const MAX_ERROR_MESSAGE_CHARS = 800;

/**
 * 把错误提取成可落盘的留痕
 *
 * 只读取观测属性（Symbol 键），不解析 message 文本：分类决策依赖 message，
 * 落盘侧再做正则解析会让「记录」与「决策」两套口径漂移。
 *
 * @param err - 调用失败时的原始错误
 * @returns 可序列化的错误留痕
 */
export function describeWireError(err: unknown): WireCallErrorInfo {
  const isError = err instanceof Error;
  const message = isError ? err.message : String(err);
  const info: WireCallErrorInfo = {
    message: message.length > MAX_ERROR_MESSAGE_CHARS ? `${message.slice(0, MAX_ERROR_MESSAGE_CHARS)}…` : message,
  };
  if (isError && err.name) info.name = err.name;

  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') info.code = code;
  }

  const httpStatus = readHttpStatus(err);
  if (httpStatus !== undefined) info.httpStatus = httpStatus;

  // 回退链单节点预算耗尽：与「用户主动取消」在留痕里必须可辨，
  // 否则「节点只是慢」会被误读成「用户点了停止」。
  const budgetMs = readAttemptBudgetExhausted(err);
  if (budgetMs !== undefined) info.attemptBudgetMs = budgetMs;

  const diag = readStreamDiag(err);
  if (diag) {
    info.keepalives = diag.keepalives;
    info.contentChunks = diag.contentChunks;
    info.streamBytes = diag.bytes;
    info.firstBytesAt = diag.firstBytesAt;
    info.lastBytesAt = diag.lastBytesAt;
    info.sawEnd = diag.sawEnd;
  }

  return info;
}

/** 缺省落盘根目录 */
export function defaultWireDumpDir(): string {
  return join(getOctopiHome(), 'logs', 'llm-requests');
}

/**
 * 从 wire body 提取前缀单元文本（比对与落盘的唯一权威顺序）
 *
 * - OpenAI：`body.messages`
 * - Anthropic：顶层 `system`（字符串）+ `body.messages`；system 在 wire 语义上位于最前
 *
 * @param body - provider 实际发送的请求体
 * @returns 前缀单元（role + 该单元 JSON 文本）
 */
export function wireUnitPayloads(body: Record<string, unknown>): Array<{ role: string; text: string }> {
  const payloads: Array<{ role: string; text: string }> = [];
  const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];

  // 顶层 system 在 wire 语义上永远位于最前，无条件作为首单元：
  // 若某 body 同时含 inline system 消息（第三方 provider 可能如此），漏掉顶层 system
  // 会让它的变化完全不触发 divergence。OpenAI/Anthropic 都不会产生这种并存。
  const system = body.system;
  if (typeof system === 'string' && system.length > 0) {
    payloads.push({ role: 'system', text: JSON.stringify({ role: 'system', content: system }) });
  }

  for (const msg of messages) {
    const role =
      msg != null && typeof msg === 'object' && typeof (msg as { role?: unknown }).role === 'string'
        ? ((msg as { role: string }).role)
        : 'unknown';
    payloads.push({ role, text: JSON.stringify(msg ?? null) });
  }

  return payloads;
}

/**
 * 从 wire body 提取用于前缀比对的最小单元序列
 *
 * @param body - provider 实际发送的请求体
 * @returns 前缀单元（role/len/hash）
 */
export function extractWireUnits(body: Record<string, unknown>): WireUnit[] {
  return wireUnitPayloads(body).map((p) => ({ role: p.role, len: p.text.length, hash: shortHash(p.text) }));
}

/** 目录名安全化：sessionId 可能含 `:` `/` 等 */
export function sanitizeSessionDirName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || '_unknown';
}

/**
 * 创建 wire dump sink
 *
 * @param options - 落盘目录 / 环形上限 / 身份解析
 * @returns sink；capture 返回的句柄用于回填结果
 */
export function createWireDumpSink(options: WireDumpHookOptions = {}): WireDumpSink {
  const rootDir = options.dir ?? defaultWireDumpDir();
  const maxCalls = options.maxCallsPerSession ?? 200;
  const maxBodyBytes = options.maxBodyBytes ?? 8_000_000;
  const resolveContext = options.resolveContext;

  let seq = 0;
  let queue: Promise<void> = Promise.resolve();
  // 调用 id 的实例段：同进程内可能有多个 sink（daemon + 一次 CLI run），
  // 各自 seq 从 1 起、Date.now() 同毫秒，只靠 at+seq 会撞 id，裁剪时连新行一起删掉
  const instanceTag = randomBytes(4).toString('hex');
  /** session 目录 → 已写调用 id（升序），用于环形裁剪 */
  const writtenBySession = new Map<string, string[]>();
  const primedSessions = new Set<string>();

  const enqueue = (task: () => void): void => {
    queue = queue.then(() => task()).catch(() => {
      // 观测 fail-open：写盘失败绝不影响请求路径（唯一失败面是本模块自身的 IO）
    });
  };

  const sessionDirPath = (sessionId: string): string =>
    join(rootDir, sanitizeSessionDirName(sessionId));

  /**
   * 首次写入某 session 时，用磁盘现有索引恢复环形状态（进程重启不覆盖旧文件）
   *
   * 以 index.jsonl 的 request 行顺序为准：oversize 调用没有 body 文件，只扫目录会漏掉它们，
   * 导致这些行的环形逐出永远不发生。旧目录（索引尚未生成）才退回按 body 文件名恢复。
   */
  const primeSession = (dir: string): void => {
    if (primedSessions.has(dir)) return;
    primedSessions.add(dir);
    const indexPath = join(dir, 'index.jsonl');
    try {
      if (existsSync(indexPath)) {
        const ids = readFileSync(indexPath, 'utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            try {
              const rec = JSON.parse(line) as WireDumpIndexRecord;
              return rec.type === 'request' ? rec.id : null;
            } catch {
              // 半行（进程被杀）没有 id 可供恢复；后续行仍可读
              return null;
            }
          })
          .filter((id): id is string => id != null);
        writtenBySession.set(dir, ids);
        return;
      }
      if (!existsSync(dir)) return;
      const ids = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length))
        .sort(compareCallIds);
      writtenBySession.set(dir, ids);
    } catch {
      writtenBySession.set(dir, []);
    }
  };

  /** 环形裁剪：删除最旧 body 文件并压缩索引（保持 index 与现存 body 一致） */
  const trimSession = (dir: string): void => {
    const ids = writtenBySession.get(dir) ?? [];
    if (ids.length <= maxCalls) return;
    const remove = ids.splice(0, ids.length - maxCalls);
    const removeSet = new Set(remove);
    for (const id of remove) {
      try {
        unlinkSync(join(dir, `${id}.json`));
      } catch {
        // 文件可能已被人工清理；索引压缩仍按 removeSet 进行
      }
    }
    const indexPath = join(dir, 'index.jsonl');
    try {
      if (!existsSync(indexPath)) return;
      const records = readFileSync(indexPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as WireDumpIndexRecord;
          } catch {
            return null;
          }
        })
        .filter((rec): rec is WireDumpIndexRecord => rec != null)
        .filter((rec) => !removeSet.has(rec.id));
      // 没有对应 request 行的 result（旧数据/人工删行后）一并清掉，避免孤儿行无限累积
      const liveIds = new Set(records.filter((rec) => rec.type === 'request').map((rec) => rec.id));
      const kept = records
        .filter((rec) => rec.type === 'request' || liveIds.has(rec.id))
        .map((rec) => JSON.stringify(rec));
      writeFileSync(indexPath, kept.length > 0 ? `${kept.join('\n')}\n` : '');
    } catch {
      // 索引压缩失败仅导致索引偏大；body 已删，diff 侧按缺失 body 降级为纯 hash 比对
    }
  };

  const capture = (input: WireCaptureInput): WireCallHandle => {
    const ctx = resolveContext?.();
    const sessionId = ctx?.sessionId ?? '_unscoped';
    const dir = sessionDirPath(sessionId);
    const at = Date.now();
    seq += 1;
    const n = seq;
    // 实例段保证跨 sink / 跨进程唯一：at+seq 在同毫秒内会重复
    const id = `${at}-${n}-${instanceTag}`;

    // 序列化/哈希在调用方线程完成：body 在此刻定型（排队期间不会被后续代码改写），
    // 只有落盘 I/O 进入队列——「不阻塞调用方」指不等待磁盘。
    const units = extractWireUnits(input.body);
    const bodyJson = JSON.stringify(input.body);
    const bodyBytes = Buffer.byteLength(bodyJson, 'utf8');
    const oversize = bodyBytes > maxBodyBytes;
    const toolJson = input.body.tools ? JSON.stringify(input.body.tools) : '';
    const toolsHash = toolJson ? shortHash(toolJson) : '';
    const chars = units.reduce((sum, u) => sum + u.len, 0);

    const request: WireDumpRequestRecord = {
      type: 'request',
      id,
      at,
      n,
      sessionId: ctx?.sessionId,
      agentId: ctx?.agentId,
      runId: ctx?.runId,
      provider: input.provider,
      model: input.model,
      mode: input.mode,
      msgCount: units.length,
      chars,
      bodyBytes,
      oversize,
      toolCount: Array.isArray(input.body.tools) ? (input.body.tools as unknown[]).length : 0,
      toolsHash,
      roles: units.map((u) => u.role),
      lens: units.map((u) => u.len),
      hashes: units.map((u) => u.hash),
      file: oversize ? undefined : `${id}.json`,
    };

    enqueue(() => {
      mkdirSync(dir, { recursive: true });
      primeSession(dir);
      if (!oversize) {
        writeFileSync(join(dir, `${id}.json`), bodyJson);
      }
      const ids = writtenBySession.get(dir) ?? [];
      ids.push(id);
      writtenBySession.set(dir, ids);
      appendFileSync(join(dir, 'index.jsonl'), `${JSON.stringify(request)}\n`);
      trimSession(dir);
    });

    return {
      id,
      finish: (result) => {
        const record: WireDumpResultRecord = {
          type: 'result',
          id,
          at: Date.now(),
          outcome: result.outcome,
          durationMs: Math.max(0, Math.round(result.durationMs)),
          ttftMs: result.ttftMs != null ? Math.max(0, Math.round(result.ttftMs)) : undefined,
          ...(result.error ? { error: result.error } : {}),
          usage: result.usage
            ? {
                inputCachedTokens: result.usage.inputCachedTokens,
                inputUncachedTokens: result.usage.inputUncachedTokens,
                inputCacheWriteTokens: result.usage.inputCacheWriteTokens,
                inputReportedTokens: result.usage.inputReportedTokens,
                outputTokens: result.usage.outputTokens,
                cacheAware: result.usage.cacheAware,
              }
            : undefined,
        };
        enqueue(() => {
          // 该调用的 request 行已被环形裁剪（长流式调用可能在收尾前被逐出）：
          // 再追加 result 只会留下永远不被逐出的孤儿行，直接丢弃
          const ids = writtenBySession.get(dir);
          if (!ids?.includes(id)) return;
          appendFileSync(join(dir, 'index.jsonl'), `${JSON.stringify(record)}\n`);
        });
      },
    };
  };

  return {
    capture,
    flush: () => queue,
  };
}

/** 16 位短 hash（sha256 前 8 字节）——足够区分前缀单元，日志体积可控 */
function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * 调用 id 形如 `<at>-<n>-<instanceTag>`：按 `at`、`n` 数值比较，其余段按字符串
 *
 * 整体字典序会把 `n=10` 排到 `n=2` 之前，环形逐出会因此删错调用。
 *
 * @param a - 调用 id
 * @param b - 调用 id
 * @returns 比较结果（<0 / 0 / >0）
 */
function compareCallIds(a: string, b: string): number {
  const pa = a.split('-');
  const pb = b.split('-');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i] ?? '';
    const sb = pb[i] ?? '';
    const na = Number(sa);
    const nb = Number(sb);
    if (sa !== '' && sb !== '' && Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

// ── Provider 装饰器 ──

/** provider 侧可选的 wire body 构造能力（与内部发送路径共用同一 builder） */
export interface WireBodyBuilder {
  /**
   * 构造实际发送的请求体
   *
   * @param request - 原始 LLM 请求
   * @param mode - chat 或 stream（stream 会附加流式开关）
   * @returns 与 provider 内部发送的 body 一致的对象
   */
  wireBodyFor(request: LLMRequest, mode: 'chat' | 'stream'): Record<string, unknown>;
}

/**
 * 给 provider 套一层 wire dump 装饰器
 *
 * 请求体由 provider 自己的 `wireBodyFor` 构造（同一 builder），装饰器只负责落盘与计时；
 * 不支持该能力的 provider 原样透传（不落盘）。
 *
 * @param inner - 真实 provider
 * @param sink - 落盘 sink
 * @returns 透传装饰器
 */
export function withWireDump(inner: ModelProvider, sink: WireDumpSink): ModelProvider {
  const builder = inner as Partial<WireBodyBuilder>;
  const buildBody = (request: LLMRequest, mode: 'chat' | 'stream'): Record<string, unknown> | null => {
    if (typeof builder.wireBodyFor !== 'function') return null;
    try {
      return builder.wireBodyFor.call(inner, request, mode);
    } catch {
      // 观测 fail-open：body 构造失败绝不能影响真实请求（唯一失败面是本模块自身的判定）
      return null;
    }
  };
  const modelOf = (request: LLMRequest): string => request.model ?? inner.defaultModel ?? '';
  /** 捕获失败（hash/序列化异常）不得影响真实请求 */
  const tryCapture = (request: LLMRequest, mode: 'chat' | 'stream'): WireCallHandle | undefined => {
    try {
      const body = buildBody(request, mode);
      if (!body) return undefined;
      return sink.capture({ provider: inner.name, model: modelOf(request), mode, body });
    } catch {
      return undefined;
    }
  };

  return {
    name: inner.name,
    defaultModel: inner.defaultModel,
    models: inner.models,
    isAvailable: () => inner.isAvailable(),
    getModelInfo: (modelName: string) => inner.getModelInfo(modelName),
    getModelInfos: () => inner.getModelInfos(),
    chat: async (request) => {
      const handle = tryCapture(request, 'chat');
      const startedAt = Date.now();
      try {
        const res = await inner.chat(request);
        handle?.finish({ outcome: 'ok', usage: res.usage, durationMs: Date.now() - startedAt });
        return res;
      } catch (err) {
        handle?.finish({ outcome: 'error', durationMs: Date.now() - startedAt, error: describeWireError(err) });
        throw err;
      }
    },
    stream: async function* (request) {
      const handle = tryCapture(request, 'stream');
      if (!handle) {
        yield* inner.stream(request);
        return;
      }
      const startedAt = Date.now();
      let ttftMs: number | undefined;
      let usage: TokenUsage | undefined;
      let sawDone = false;
      let completed = false;
      let failed = false;
      let failedErr: unknown;
      try {
        for await (const chunk of inner.stream(request)) {
          if (ttftMs == null) ttftMs = Date.now() - startedAt;
          if (chunk.type === 'done') {
            sawDone = true;
          }
          // usage 通常只在 done chunk 上；任何 chunk 携带都取，避免缺哨兵时丢掉已消耗额度
          if (chunk.usage) usage = chunk.usage;
          yield chunk;
        }
        completed = true;
      } catch (err) {
        failed = true;
        failedErr = err;
        throw err;
      } finally {
        handle.finish({
          // 正常读完但服务端没发 done 哨兵（代理断流/兼容实现）不等于消费者放弃：
          // 判 abandoned 会把真实完成记成"提前中断"，并误报给 llm-diff
          outcome: failed ? 'error' : sawDone || completed ? 'ok' : 'abandoned',
          usage,
          ttftMs,
          durationMs: Date.now() - startedAt,
          ...(failed ? { error: describeWireError(failedErr) } : {}),
        });
      }
    },
  };
}
