/**
 * Run 契约线上协议（arch/service-topology.md §4「P0b 落地形态」）。
 *
 * 两个通道，各司其职：
 * - **契约通道**（gateway → run 实例，loopback HTTP）：`POST /runs`（RunRequest →
 *   NDJSON `RunStreamEntry` 流）/ `POST /control`（`RunControlOp`）/ `GET /health`；
 * - **宿主通知**（run 实例 → gateway，fork IPC）：`RunHostNotify`——审批请求、
 *   客户端工具调用、out-of-run 会话事件、inbox 重投等控制面推送。
 *
 * 纪律：本文件只放**可序列化**数据形状；函数型参数禁止上契约（P0a 债务已随
 * compactSession 数据化清偿）。审批/工具事件直接复用 hooks 既有数据类型（单一来源）。
 */

import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import type { Message, ToolDefinition, ToolSource } from '@octopi-agent/core/types.js';
import type { Trigger } from './types.js';
import type { CommandDefinition } from '../extension/plugin-ecosystem/commands/types.js';
import type { HitlAskResult } from '../governance/human-in-the-loop/decision-cache.js';

// ── 契约通道：/runs 事件流 ──

/** 线上错误形状（两形态错误表面的传输载体：同步抛 = HTTP 4xx/5xx body；闸门拒 = 流内 error entry） */
export interface RunWireError {
  message: string;
  name?: string;
}

/**
 * `POST /runs` 响应流（NDJSON，逐行一个 entry）：
 * 事件流若干 `{type:'event'}`，然后恰好一个终态 `done` 或 `error`。
 * 流内 error = 异步错误表面（准入闸门拒等）；未装载等同步错误不进流，直接 HTTP 4xx。
 */
export type RunStreamEntry =
  | { type: 'event'; event: AgentEvent }
  | { type: 'done' }
  | { type: 'error'; error: RunWireError };

// ── 契约通道：/control ──

/** 客户端工具注册的线上形状（handler 不可传输；由 run 侧桥接实现承接） */
export interface ClientToolWireSpec {
  definition: ToolDefinition;
  source?: ToolSource;
}

/**
 * 客户端工具可见性快照（`createVisibilityFilter` 谓词的数据化）：
 * gateway 在注册表变化时推送 + 周期 diff 刷（TTL 过期是「心跳缺失」——缺因态没有
 * 事件可挂，生产者只能是时间刷），run 侧本地求值（stale 窗口 = 推送间隔，已声明收敛）。
 */
export interface ClientToolVisibilitySnapshot {
  /** ClientToolHost 已安装的客户端工具名（非安装名单内的工具恒可见） */
  installed: string[];
  /** 当前有 live provider 的 (session, tool) 对 */
  live: Array<{ sessionId: string; toolName: string }>;
  /**
   * 快照有效期（epoch ms）：过期后 run 侧按 fail-safe 收敛——已安装的客户端工具
   * 一律不可见（liveness 未知时宁缺勿滥；pre-P0b 实时求值 = 无 live provider 即隐藏）。
   */
  expiresAt: number;
}

/**
 * 会话级控制 op（纯数据）。对应契约 `control(op)`：
 * 每个 op 都有对应的 run 侧执行语义（RunHost.handleControl）。
 */
export type RunControlOp =
  /** 中止会话在途 run（不丢内容；对应 run 侧 AbortController 集合） */
  | { type: 'abort'; sessionId: string; reason?: string }
  /**
   * 会话消息追加（schedule 通知投递等控制面写路径；写者单点 = run 节点，§3）。
   * 执行：sessionLock → load → push → save（与 Runner.handle 共锁，防漂移整包抹除）。
   */
  | { type: 'sessionAppendMessage'; sessionId: string; message: Message }
  /**
   * 截断会话消息（编辑重发/丢弃的唯一入口）。执行含本轮校验（仅最后一轮中止）、
   * 租约下标收缩、abortedTurn 清理与本轮文件效应逆放（用户手改保留）。
   */
  | { type: 'truncateMessagesFrom'; sessionId: string; fromIndex: number }
  /** 审批回执（答复 RunHostNotify.approval_request；HitlAskResult 为既有数据形状） */
  | { type: 'approvalReply'; approvalId: string; result: HitlAskResult }
  /** 客户端工具结果回传（答复 RunHostNotify.client_tool_call） */
  | {
      type: 'clientToolResult';
      callId: string;
      outcome: { ok: true; result: unknown } | { ok: false; error: RunWireError };
    }
  /** ask_user 作答回传（答复 RunHostNotify.ask_user_request；失败拒接让工具 fail-loud） */
  | {
      type: 'askUserReply';
      askId: string;
      outcome: { ok: true; answer: string } | { ok: false; error: RunWireError };
    }
  /**
   * 会话压缩。**纯数据**：systemPrompt/tools/摘要模型绑定等全部由 run 侧从自身
   * 状态解析（P0a 迁移注记的清偿形态）；控制面只传键。
   */
  | { type: 'compact'; sessionId: string; agentId: string }
  /** 热重建：新 AgentDefinition 数据下发，run 侧重建执行体（旧体退役判据不变） */
  | { type: 'reloadAgent'; agentId: string; definition: AgentDefinitionWire }
  /** 退役执行体（removeAgent） */
  | { type: 'retireAgent'; agentId: string }
  /** 动态客户端工具同步（E5 语义：add/remove + 可见性快照） */
  | {
      type: 'setClientTools';
      ops: Array<{ op: 'add'; tool: ClientToolWireSpec } | { op: 'remove'; name: string }>;
      visibility: ClientToolVisibilitySnapshot;
    }
  /** 知识运行时状态同步（准入闸门输入；状态是 gateway 运行时已知值，非实时探测） */
  | { type: 'syncKnowledgeState'; state: KnowledgeStateWire }
  /** 七层上下文健康探针 */
  | { type: 'contextHealth'; agentId?: string }
  /**
   * console 受控写后重锚定安全指纹（ops P2 §8.4）。boot 纯数据无法携带活守卫，
   * run 实例自建 guard 后由宿主经此 op 同步署名（service-topology §7.3）。
   */
  | { type: 'reattestSecurity'; expectHash: string; allowedChanged: string[] }
  /**
   * 脉搏（P0c 脉搏单源，arch/service-topology-p0c.md §3 方案 A′）：gateway 脉搏调度器
   * 单发，副本收到后跑一次声明式 tick（原 self-arm 定时器的驱动源）。key 是实例自述的
   * `PulseSpec.key`（opaque，gateway 不解释产品语义）。
   */
  | { type: 'pulse'; key: string };

/**
 * 脉搏声明（P0c A′）：run 实例装配后自述「我有哪些周期任务」，gateway 单发驱动。
 * key 在实例内全局唯一（`<agentId>:<base>` 形态，产品语义不进 gateway）。
 */
export interface PulseSpec {
  /** 实例内唯一脉搏键（opaque） */
  key: string;
  /** 周期（毫秒） */
  intervalMs: number;
  /** 归属 agent（诊断用） */
  agentId?: string;
  /** 首次收集后立即发一跳（替代原 runOnStart 自跳） */
  runOnStart?: boolean;
}

/**
 * 冒烟报告（健康门 §4.3）——`POST /smoke` 独立通道的应答（**不是 run，不占 run 语义**）。
 * 逐 agent 装配热路径自检：工具面枚举 + 一次 no-LLM 应答（contextHealth）。
 */
export interface RunSmokeReport {
  ok: boolean;
  /**
   * 该构建无冒烟端点（跨版本：pre-v0.108.2）——消费方降级为 health+guard 判定（MAJ-3），
   * 不得当作冒烟失败挡回滚。
   */
  unavailable?: boolean;
  agents: Array<{
    agentId: string;
    toolCount: number;
    checks: Array<{ name: string; ok: boolean; detail?: string }>;
  }>;
}

/** AgentDefinition 线上传输别名（config-schema 数据对象，见 src/config-schema） */
export type AgentDefinitionWire = Record<string, unknown>;

/** 知识运行时状态（与 gateway KnowledgeRuntimeState 同枚举；线上自包含） */
export type KnowledgeStateWire = 'starting' | 'disabled' | 'ready' | 'degraded';

/** control 响应：成功（result 形状随 op）或失败（不得静默吞，见契约错误表面） */
export type RunControlResponse =
  | { ok: true; result?: unknown }
  | { ok: false; error: RunWireError };

// ── 宿主通知：run 实例 → gateway（fork IPC） ──

/**
 * 审批请求载荷（Gateway.requestApproval 同构的纯数据面；引擎侧自包含）。
 * 插件工具审批（HookToolEvent/HookToolApproval）经 toolApprovalToRequestInput 归一到此形。
 */
export interface RunApprovalRequestInput {
  sessionId: string;
  agentId: string;
  request: {
    kind: 'high_risk' | 'effect';
    toolName: string;
    arguments: Record<string, unknown>;
    riskLevel: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
    riskDescription: string;
    actionDescription: string;
  };
  timeoutMs?: number;
}

/**
 * run 实例进程向 gateway 的控制面推送。审批请求走这里而非 run 流：
 * 工具审批可发生在任意执行上下文，且请求/回执是跨通道配对（notify 出、control 回）。
 */
export type RunHostNotify =
  /** 审批请求（gateway 挂 UI 通道；回执走 control 'approvalReply'） */
  | { type: 'approval_request'; approvalId: string; input: RunApprovalRequestInput }
  /** 客户端工具调用（gateway 转发客户端执行；结果走 control 'clientToolResult'） */
  | {
      type: 'client_tool_call';
      callId: string;
      sessionId: string;
      agentId: string;
      toolName: string;
      args: Record<string, unknown>;
      /**
       * 调用时刻的 episode 消息列表（ToolExecutionContext.messages 的跨进程还原）。
       * 随桥携带是有意的载荷成本：handler 契约承诺真实 messages，禁以空数组冒充。
       */
      messages: Message[];
    }
  /**
   * 客户端工具调用取消（run 侧中止信号触发）。gateway 据此中止该 callId 的
   * 执行腿（per-call AbortSignal），否则 pending 会挂到 TTL 过期——覆盖不经
   * `abortSession()` 的中止路径（runGuard/budget/引擎内中止等）。
   */
  | { type: 'client_tool_cancel'; callId: string; reason?: string }
  /** out-of-run 会话事件（compact 进度、ClientToolHost 会话事件等；gateway 转 WS/store） */
  | { type: 'session_event'; sessionId: string; event: AgentEvent }
  /** inbox 未消费项的原 Trigger 重投（原 registerRuntimeAgent.redispatch 的远程形态） */
  | { type: 'redispatch'; trigger: Trigger }
  /** ask_user 提问（gateway 挂 pending question 等 UI 作答；回执走 control 'askUserReply'） */
  | {
      type: 'ask_user_request';
      askId: string;
      sessionId: string;
      agentId: string;
      question: string;
      options?: string[];
    }
  /** 命令注册（skill/用户命令发现结果，数据下发；gateway 注册 UI 命令面） */
  | {
      type: 'commands_registered';
      agentId: string;
      commands: Array<{ definition: CommandDefinition; ref: string }>;
    }
  /** run 侧日志转发（保 [Gateway] 前缀文案的运维 grep 面） */
  | { type: 'log'; level: 'log' | 'warn' | 'error'; message: string }
  /**
   * 会话写入已落盘（P1-1 投影收口：检索投影单写者=gateway 门面，§3 表）。
   * run 节点直写会话文件后发此通知（载荷只有 id），gateway 侧节流补投影；
   * 投影可重建非权威（I2），通知丢失仅滞后检索，由 rebuild 兜底。
   */
  | { type: 'session_saved'; sessionId: string }
  /** 会话删除已落盘（同上收口：gateway 门面据此删投影行） */
  | { type: 'session_removed'; sessionId: string };
