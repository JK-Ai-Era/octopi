/**
 * Octopi TUI App
 *
 * 纯 Gateway 客户端模式。
 * TUI 只负责 UI 渲染和事件展示，所有引擎逻辑在 Gateway 侧。
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  TUI,
  Text,
  Editor,
  ProcessTerminal,
  Container,
  Key,
  matchesKey,
  isKeyRelease,
  CombinedAutocompleteProvider,
} from '@earendil-works/pi-tui';
import { theme, editorTheme } from './theme.js';
import { ChatLog } from './components.js';
import { TuiGatewayApi, type TuiSessionItem } from './gateway-api.js';
import { toChatEntries, formatSessionList, pickSession, type ChatEntry } from './history.js';
import { formatIssueList, formatIssueDetail, findIssue, type TuiIssue } from './issues.js';
import { searchMessages } from './search.js';
import { expandFileReferences } from './attach.js';
import { reconnectDelay, DEFAULT_RECONNECT_PLAN } from './reconnect.js';
import type { Message } from '@octopi-agent/core/types/messages.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import { GatewayChatClient } from '@octopi-agent/gateway/gateway/client.js';

// ── Types ──

export interface TuiAppConfig {
  agentId: string;
  /** Gateway URL（如 http://localhost:18180） */
  gatewayUrl: string;
  /** Gateway apiKey（channels.http.apiKey）；配置后连接首条消息送 auth */
  apiKey?: string;
  /** 启动即续接的会话 id（加载最近历史）；缺省开新会话 */
  resumeSessionId?: string;
}

interface SlashCommand {
  name: string;
  description: string;
  getArgumentCompletions?: (prefix: string) => { value: string; label: string }[];
}

// ── Custom Editor ──

class OctopiEditor extends Editor {
  onEscape?: () => void;
  onCtrlC?: () => void;
  onCtrlD?: () => void;
  onCtrlO?: () => void;
  onCtrlL?: () => void;

  override handleInput(data: string): void {
    if (isKeyRelease(data)) return;

    if (matchesKey(data, Key.escape) && this.onEscape && !this.isShowingAutocomplete()) {
      this.onEscape();
      return;
    }
    if (matchesKey(data, Key.ctrl('c')) && this.onCtrlC) {
      this.onCtrlC();
      return;
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      if (this.getText().length === 0 && this.onCtrlD) this.onCtrlD();
      return;
    }
    if (matchesKey(data, Key.ctrl('o')) && this.onCtrlO) {
      this.onCtrlO();
      return;
    }
    if (matchesKey(data, Key.ctrl('l')) && this.onCtrlL) {
      this.onCtrlL();
      return;
    }
    super.handleInput(data);
  }
}

// ── Helper ──

function formatToolArgs(toolName: string, args: string): string {
  if (!args) return '';
  try {
    const parsed = JSON.parse(args);
    const entries = Object.entries(parsed);
    if (entries.length === 0) return '';
    const parts = entries.slice(0, 3).map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      const truncated = val.length > 40 ? val.slice(0, 40) + '…' : val;
      return `${k}=${truncated}`;
    });
    if (entries.length > 3) parts.push(`…+${entries.length - 3}`);
    return parts.join(' ');
  } catch {
    return args.length > 60 ? args.slice(0, 60) + '…' : args;
  }
}

// ── TuiApp ──

export class TuiApp {
  private config: TuiAppConfig;
  private tui: TUI;
  private chatLog: ChatLog;
  private editor: OctopiEditor;
  private header: Text;
  private footer: Text;
  private statusText: Text;

  private gatewayClient: GatewayChatClient | null = null;
  private api: TuiGatewayApi;
  private sessionItems: TuiSessionItem[] = [];
  private currentModel = '';
  private commandCatalog: SlashCommand[] = [];
  private openIssues: TuiIssue[] = [];

  private sessionIdRef = { current: '' };
  private toolsExpanded = false;
  private lastCtrlCAt = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private exitRequested = false;
  private isProcessing = false;
  private streamedContent = '';
  private exitResolve?: () => void;

  // Context 信息
  private contextTokens = 0;
  private contextWindow = 0;

  constructor(config: TuiAppConfig) {
    this.config = config;
    this.api = new TuiGatewayApi({ baseUrl: config.gatewayUrl, apiKey: config.apiKey });
    this.sessionIdRef.current = `${config.agentId}:cli:${Date.now()}`;

    const terminal = new ProcessTerminal();
    this.tui = new TUI(terminal);

    this.header = new Text('', 1, 0);
    this.chatLog = new ChatLog();
    this.statusText = new Text('', 1, 0);
    this.footer = new Text('', 1, 0);
    this.editor = new OctopiEditor(this.tui, editorTheme);

    const root = new Container();
    root.addChild(this.header);
    root.addChild(this.chatLog);
    root.addChild(this.statusText);
    root.addChild(this.footer);
    root.addChild(this.editor);
    this.tui.addChild(root);
    this.tui.setFocus(this.editor);
  }

  async start(): Promise<void> {
    await this.connectGateway();

    // 连接失败，直接退出
    if (this.exitRequested) {
      return;
    }

    this.setupEditor();
    this.setupInputHandler();
    this.updateHeader();
    this.updateFooter();

    this.chatLog.addSystem(`🐙 Octopi Chat — ${this.currentModel || this.config.agentId}`);
    this.chatLog.addSystem(`Type /help for commands, Ctrl+C to exit.`);

    // --resume <id>：启动即续接（历史加载失败则回退新会话，明确告知）
    if (this.config.resumeSessionId) {
      const target = this.config.resumeSessionId;
      try {
        await this.loadHistory(target);
        this.sessionIdRef.current = target;
        this.gatewayClient?.subscribe(target, this.config.agentId);
      } catch (err) {
        this.chatLog.addSystem(
          `⚠️ 续接会话失败（${err instanceof Error ? err.message : String(err)}），已回退为新会话`,
        );
      }
    }

    this.tui.requestRender();

    this.tui.start();

    // 等待退出信号（由 requestExit/forceExit 触发）
    await new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });

    this.tui.stop();
  }

  // ── Gateway Connection ──

  private async connectGateway(): Promise<void> {
    this.gatewayClient = new GatewayChatClient({ url: this.config.gatewayUrl, apiKey: this.config.apiKey });

    this.gatewayClient.on({
      onEvent: (event) => this.handleAgentEvent(event),
      onConnected: () => {
        this.chatLog.addSystem('✅ Connected to Gateway');
        this.tui.requestRender();
      },
      onGatewayInfo: (info) => {
        if (info.commands?.length) {
          this.commandCatalog = info.commands.map((c) => ({
            name: c.name,
            description: c.description,
          }));
          this.setupEditorAutocomplete();
        }
        if (info.issues?.length) {
          this.openIssues = info.issues.map((i) => ({
            id: i.id,
            severity: i.severity,
            title: i.title,
            detail: i.detail,
          }));
          this.chatLog.addSystem(`⚠️ ${this.openIssues.length} open system issue(s) — /issues`);
        }
        if (info.agents?.length) {
          const agent = info.agents.find(a => a.id === this.config.agentId) ?? info.agents[0];
          if (agent?.model?.model) {
            this.currentModel = agent.model.model;
            this.updateHeader();
            this.updateFooter();
            this.chatLog.addSystem(`🐙 Octopi Chat — ${this.currentModel}`);
            this.tui.requestRender();
          }
        }
      },
      onDisconnected: (reason) => {
        this.chatLog.addSystem(`❌ Disconnected from Gateway: ${reason ?? 'unknown'}`);
        if (this.isProcessing) {
          if (this.streamedContent) {
            this.chatLog.finalizeAssistant(this.streamedContent + '\n\n*(connection lost)*', 'run');
          }
          this.streamedContent = '';
          this.isProcessing = false;
          this.setStatus('disconnected');
        }
        this.tui.requestRender();
        // 断线自动重连（指数退避）；用户主动退出（exitRequested）不触发
        if (!this.exitRequested) {
          this.scheduleReconnect();
        }
      },
      onError: (err) => {
        this.chatLog.addSystem(`⚠️ Gateway error: ${err.message}`);
        this.tui.requestRender();
      },
    });

    try {
      await this.gatewayClient.connect();
    } catch (err: any) {
      this.chatLog.addSystem(`❌ Failed to connect to Gateway: ${err.message}`);
      this.chatLog.addSystem(`Make sure the gateway is running: octopi serve start`);
      this.exitRequested = true;
    }
  }

  // ── Event Handler（唯一的一套） ──

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      // ── 命令结果（engine CommandRouter） ──
      case 'command.result': {
        const newSessionId = event.data?.newSessionId as string | undefined;
        const enterLoop = event.data?.enterLoop as boolean | undefined;
        // 正文由合成 turn.end 走 assistant 渲染；这里只处理会话切换等元数据
        if (newSessionId) {
          this.sessionIdRef.current = newSessionId;
          this.streamedContent = '';
          this.chatLog.addSystem(`🐙 Session → ${newSessionId}`);
        }
        if (!enterLoop) {
          this.isProcessing = false;
          this.setStatus('');
        }
        this.tui.requestRender();
        break;
      }

      case 'system.issue': {
        const issue = event.data?.issue as Partial<TuiIssue> | undefined;
        if (issue?.title) {
          // 登记进 openIssues（welcome 快照之后新发的问题也能被 /issues 查到/查详情）
          this.openIssues = [
            ...this.openIssues.filter((i) => i.id !== (issue.id ?? issue.title)),
            {
              id: issue.id ?? issue.title,
              severity: issue.severity ?? 'warning',
              title: issue.title,
              detail: issue.detail ?? '',
            },
          ];
          this.chatLog.addSystem(`⚠️ [${issue.severity ?? 'warning'}] ${issue.title}`);
          if (issue.detail) this.chatLog.addSystem(`   ${issue.detail}`);
          this.tui.requestRender();
        }
        break;
      }

      case 'system.issue.resolved': {
        const id = event.data?.id as string | undefined;
        this.openIssues = this.openIssues.filter((i) => i.id !== id);
        break;
      }

      // ── 流式内容 ──
      case 'llm_stream_delta': {
        const delta = event.data?.delta as string;
        if (delta) {
          if (!this.streamedContent) {
            this.chatLog.startAssistant('', 'run');
            this.setStatus('streaming...');
          }
          this.streamedContent += delta;
          this.chatLog.updateAssistant(this.streamedContent, 'run');
          this.tui.requestRender();
        }
        break;
      }

      // ── 工具执行 ──
      case 'tool.exec.start': {
        const toolName = event.data?.toolName as string ?? 'unknown';
        const toolArgs = event.data?.args as string ?? '';
        const toolCallId = event.data?.toolCallId as string ?? `tool_${Date.now()}`;
        this.chatLog.startTool(toolCallId, toolName, formatToolArgs(toolName, toolArgs));
        this.setStatus(`running ${toolName}...`);
        this.tui.requestRender();
        break;
      }

      case 'tool.exec.end': {
        const toolCallId = event.data?.toolCallId as string;
        const result = event.data?.result as string ?? '';
        const isError = event.data?.isError as boolean ?? false;
        if (toolCallId) {
          const displayResult = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          this.chatLog.updateToolResult(toolCallId, displayResult, { isError });
        }
        this.setStatus('tool done');
        this.tui.requestRender();
        break;
      }

      // ── 工具部分输出（展示通道；载荷已过出口扫描） ──
      case 'tool.exec.update': {
        const toolCallId = event.data?.toolCallId as string | undefined;
        const content = event.data?.content;
        if (toolCallId && content != null) {
          const displayPartial =
            typeof content === 'string' ? content : JSON.stringify(content, null, 2);
          this.chatLog.updateToolPartial(toolCallId, displayPartial);
          this.tui.requestRender();
        }
        break;
      }

      // ── 回合结束 ──
      case 'turn.end': {
        const content = (event.data?.content as string) ?? '';
        const hasToolCalls = event.data?.hasToolCalls as boolean | undefined;
        const phase = (event.data?.phase as string | undefined) ?? 'final';
        // 失败尝试（turn_end error=true 只出现在重试中途）：残句不得冒充正常回复，
        // 也不算空响应；重试仍在进行，不置空闲
        const isError = (event.data as { error?: boolean } | undefined)?.error === true;
        this.chatLog.clearTransientSystem();
        if (isError) {
          if (this.streamedContent || content) {
            // 保留可见的部分输出，但明确标注为中断残句（非完整回复）
            this.chatLog.finalizeAssistant(
              `${this.streamedContent || content}\n\n*(⚠️ 本轮模型调用失败，以上为中断前的部分输出)*`,
              'run',
            );
          } else {
            this.chatLog.dropAssistant('run');
          }
          this.chatLog.addSystem('⚠️ 本轮模型调用失败');
        } else if (this.streamedContent || content) {
          this.chatLog.finalizeAssistant(this.streamedContent || content, 'run');
        } else if (hasToolCalls) {
          // 工具执行回合：无文本内容是正常的，不显示警告
          this.chatLog.dropAssistant('run');
        } else {
          this.chatLog.dropAssistant('run');
          this.chatLog.addSystem('⚠️ Empty response.');
        }
        this.streamedContent = '';

        // pre_tools：工具即将执行，保持 processing，直到 final turn_end 或 agent_end
        // error：重试仍在进行，同样保持 processing（engine.error/aborted 才是终态）
        if (isError) {
          this.setStatus('retrying…');
        } else if (phase === 'final') {
          this.isProcessing = false;
          this.setStatus('');
        } else {
          this.setStatus('running tools…');
        }

        // 更新 context 信息（来自 runner 在 turn.end 事件中附带的 LLM usage）
        const contextTokens = event.data?.contextTokens as number | undefined;
        const contextWindow = event.data?.contextWindow as number | undefined;
        if (contextTokens !== undefined) {
          this.contextTokens = contextTokens;
        }
        if (contextWindow !== undefined) {
          this.contextWindow = contextWindow;
        }
        if (contextTokens !== undefined || contextWindow !== undefined) {
          this.updateFooter();
        }

        this.tui.requestRender();
        break;
      }

      // ── 模型调用 ──
      case 'model.call.start':
        this.setStatus('calling model...');
        this.tui.requestRender();
        break;

      case 'model.call.error': {
        const errorData = event.data?.error as any;
        const reason = errorData?.reason ?? 'unknown';
        const statusCode = errorData?.statusCode;
        const detail = statusCode ? ` (HTTP ${statusCode})` : '';
        this.chatLog.addSystem(`❌ Model error: ${reason}${detail}`);
        this.isProcessing = false;
        this.setStatus('');
        this.tui.requestRender();
        break;
      }

      // ── 引擎退出事件（全部重置 isProcessing） ──

      case 'engine.error': {
        const errorData = event.data as any;
        this.chatLog.clearTransientSystem();
        this.chatLog.dropAssistant('run');
        this.chatLog.addSystem(`❌ Engine error: ${errorData?.error ?? 'unknown'}`);
        this.streamedContent = '';
        this.isProcessing = false;
        this.setStatus('');
        this.tui.requestRender();
        break;
      }

      case 'aborted': {
        const reason = event.data?.reason as string;
        this.chatLog.clearTransientSystem();
        if (this.streamedContent) this.chatLog.finalizeAssistant(this.streamedContent, 'run');
        this.chatLog.addSystem(`🛑 Aborted: ${reason ?? 'unknown'}`);
        this.streamedContent = '';
        this.isProcessing = false;
        this.setStatus('');
        this.tui.requestRender();
        break;
      }

      case 'budget.exceeded': {
        const report = event.data as any;
        this.chatLog.clearTransientSystem();
        if (this.streamedContent) this.chatLog.finalizeAssistant(this.streamedContent, 'run');
        this.chatLog.addSystem(`⛔ Budget exceeded: ${report?.status ?? 'unknown'}`);
        this.streamedContent = '';
        this.isProcessing = false;
        this.setStatus('');
        this.tui.requestRender();
        break;
      }

      case 'security.blocked':
      case 'security.behavior_blocked': {
        const reason = (event.data as any)?.reason ?? 'security violation';
        this.chatLog.clearTransientSystem();
        if (this.streamedContent) this.chatLog.finalizeAssistant(this.streamedContent, 'run');
        this.chatLog.addSystem(`🛡️ Blocked: ${reason}`);
        this.streamedContent = '';
        this.isProcessing = false;
        this.setStatus('');
        this.tui.requestRender();
        break;
      }

      case 'checkpoint.stop': {
        const data = event.data as any;
        this.chatLog.clearTransientSystem();
        if (this.streamedContent) this.chatLog.finalizeAssistant(this.streamedContent, 'run');
        this.chatLog.addSystem(`🛑 Supervisor stopped: ${data?.reason ?? 'checkpoint'}`);
        this.streamedContent = '';
        this.isProcessing = false;
        this.setStatus('');
        this.tui.requestRender();
        break;
      }

      case 'interrupted': {
        this.chatLog.clearTransientSystem();
        if (this.streamedContent) this.chatLog.finalizeAssistant(this.streamedContent, 'run');
        this.chatLog.addSystem('🛑 Interrupted.');
        this.streamedContent = '';
        this.isProcessing = false;
        this.setStatus('');
        this.tui.requestRender();
        break;
      }

      case 'engine.end': {
        // 安全网：无条件清除状态，即使 turn.end 已处理
        this.chatLog.clearTransientSystem();
        if (this.isProcessing) {
          if (this.streamedContent) {
            this.chatLog.finalizeAssistant(this.streamedContent, 'run');
          } else {
            this.chatLog.addSystem('⚠️ Agent ended without a response.');
          }
        }
        this.streamedContent = '';
        this.isProcessing = false;
        this.setStatus('');
        this.tui.requestRender();
        break;
      }

      // ── 可观测性事件（只展示，不重置状态） ──

      case 'empty_response_retry':
      case 'planning_only_retry': {
        const data = event.data as any;
        const label = event.type === 'empty_response_retry' ? 'Empty response' : 'Planning-only';
        this.chatLog.addSystem(`🔄 ${label}, retrying (${data?.attempt}/${data?.maxAttempts})...`, { transient: true });
        this.tui.requestRender();
        break;
      }

      // ── 模型重试通知（含 content_filter 内容安全拦截的原样重试） ──
      case 'engine.model_retry': {
        const data = event.data as Record<string, unknown> | undefined;
        const reason = String(data?.reason ?? 'unknown');
        const attempt = String(data?.attempt ?? '?');
        const maxAttempts = String(data?.maxAttempts ?? '?');
        const delaySec = Math.ceil(Number(data?.delayMs ?? 0) / 1000);
        this.chatLog.addSystem(
          `🔁 模型重试（${reason}）第 ${attempt}/${maxAttempts} 次${delaySec > 0 ? `，${delaySec}s 后` : ''}...`,
          { transient: true },
        );
        this.tui.requestRender();
        break;
      }

      case 'context.truncated': {
        const data = event.data as any;
        this.chatLog.addSystem(`✂️ Context truncated (${data?.from} → ${data?.to} messages)`);
        this.tui.requestRender();
        break;
      }

      // 其他事件静默忽略
    }
  }

  // ── Client-local Commands（/clear /sessions /resume /issues） ──

  /** 客户端本地命令分发；命中返回 true，否则交引擎 CommandRouter */
  private async handleLocalCommand(trimmed: string): Promise<boolean> {
    if (trimmed === '/clear') {
      this.chatLog.clear();
      this.tui.requestRender();
      return true;
    }
    if (trimmed === '/sessions') {
      await this.showSessions();
      return true;
    }
    if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
      await this.resumeSession(trimmed.slice('/resume'.length).trim());
      return true;
    }
    if (trimmed === '/issues' || trimmed.startsWith('/issues ')) {
      this.showIssues(trimmed.slice('/issues'.length).trim());
      return true;
    }
    if (trimmed === '/find' || trimmed.startsWith('/find ')) {
      await this.searchHistory(trimmed.slice('/find'.length).trim());
      return true;
    }
    return false;
  }

  // ── Issues（/issues） ──

  /**
   * 展示系统问题列表或单条详情（数据 = welcome 快照 + system.issue 事件流）。
   *
   * @param ref - 空 = 列表；序号（1 起）或问题 id = 详情
   */
  private showIssues(ref: string): void {
    const issues = this.openIssues;
    if (!ref) {
      if (issues.length === 0) {
        this.chatLog.addSystem('✅ 当前无 open 系统问题');
      } else {
        this.chatLog.addSystem(`系统问题（共 ${issues.length} 个；/issues <序号|id> 看详情）：`);
        for (const line of formatIssueList(issues)) {
          this.chatLog.addSystem(line);
        }
      }
      this.tui.requestRender();
      return;
    }
    const issue = findIssue(issues, ref);
    if (!issue) {
      this.chatLog.addSystem(`未找到系统问题：${ref}（/issues 看列表）`);
      this.tui.requestRender();
      return;
    }
    for (const line of formatIssueDetail(issue)) {
      this.chatLog.addSystem(line);
    }
    this.tui.requestRender();
  }

  // ── Sessions（/sessions /resume） ──

  private async showSessions(): Promise<void> {
    try {
      const sessions = await this.api.listSessions(this.config.agentId);
      this.sessionItems = sessions;
      if (sessions.length === 0) {
        this.chatLog.addSystem('（暂无历史会话）');
        this.tui.requestRender();
        return;
      }
      this.chatLog.addSystem(`会话列表（共 ${sessions.length} 个；/resume <序号|id> 续接）：`);
      for (const line of formatSessionList(sessions, {
        currentId: this.sessionIdRef.current,
        now: Date.now(),
      })) {
        this.chatLog.addSystem(line);
      }
    } catch (err) {
      this.chatLog.addSystem(`❌ 获取会话列表失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.tui.requestRender();
  }

  private async resumeSession(arg: string): Promise<void> {
    if (!arg) {
      this.chatLog.addSystem('用法：/resume <序号|会话id>（/sessions 查看列表）');
      this.tui.requestRender();
      return;
    }
    try {
      if (this.sessionItems.length === 0) {
        this.sessionItems = await this.api.listSessions(this.config.agentId);
      }
      const target = pickSession(this.sessionItems, arg);
      if (!target) {
        this.chatLog.addSystem(`未找到会话：${arg}（/sessions 查看列表）`);
        this.tui.requestRender();
        return;
      }
      await this.loadHistory(target.id);
      this.sessionIdRef.current = target.id;
      this.streamedContent = '';
      this.gatewayClient?.subscribe(target.id, this.config.agentId);
    } catch (err) {
      this.chatLog.addSystem(`❌ 续接会话失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.tui.requestRender();
  }

  /** 向前翻页拉取历史（backward 从末尾取，最多 pages 页 × 200 条） */
  private async fetchHistory(
    sessionId: string,
    pages: number,
  ): Promise<{ messages: Array<Message & { index: number }>; total: number }> {
    const collected: Array<Message & { index: number }> = [];
    let cursor: string | undefined;
    let total = 0;
    for (let page = 0; page < pages; page++) {
      const res = await this.api.getSessionMessages(sessionId, {
        limit: 200,
        direction: 'backward',
        cursor,
      });
      total = res.total;
      collected.unshift(...res.messages);
      if (!res.hasMore || !res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return { messages: collected, total };
  }

  /** 拉取最近历史（最多 3 页 × 200 条）并渲染进 ChatLog */
  private async loadHistory(sessionId: string): Promise<void> {
    const { messages: collected, total } = await this.fetchHistory(sessionId, 3);
    this.chatLog.clearAll();
    this.renderHistoryEntries(toChatEntries(collected));
    this.chatLog.addSystem(
      `🐙 Session → ${sessionId}（已加载最近 ${collected.length}/${total} 条消息）`,
    );
  }

  /**
   * 在会话历史文本中搜索（/find <词>）。
   *
   * @param query - 查询词（空参提示用法）
   */
  private async searchHistory(query: string): Promise<void> {
    if (!query) {
      this.chatLog.addSystem('用法：/find <关键词>（搜索当前会话历史，最多 5 页 × 200 条）');
      this.tui.requestRender();
      return;
    }
    try {
      const { messages, total } = await this.fetchHistory(this.sessionIdRef.current, 5);
      const hits = searchMessages(messages, query);
      if (hits.length === 0) {
        this.chatLog.addSystem(`在最近 ${messages.length}/${total} 条消息里没找到「${query}」`);
        this.tui.requestRender();
        return;
      }
      this.chatLog.addSystem(`「${query}」命中 ${hits.length} 条（搜了最近 ${messages.length}/${total} 条）：`);
      for (const hit of hits) {
        this.chatLog.addSystem(`#${hit.index} [${hit.role}] ${hit.snippet}`);
      }
    } catch (err) {
      this.chatLog.addSystem(`❌ 历史搜索失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.tui.requestRender();
  }

  private renderHistoryEntries(entries: ChatEntry[]): void {
    let seq = 0;
    for (const entry of entries) {
      switch (entry.kind) {
        case 'user':
          this.chatLog.addUser(entry.text);
          break;
        case 'assistant':
          this.chatLog.finalizeAssistant(entry.text, `hist-${seq++}`);
          break;
        case 'tool': {
          const id = `hist-${seq++}`;
          this.chatLog.startTool(id, entry.name, entry.args);
          this.chatLog.updateToolResult(id, entry.result, { isError: entry.isError });
          break;
        }
        case 'system':
          this.chatLog.addSystem(entry.text);
          break;
      }
    }
  }

  // ── Send ──

  private async sendMessage(text: string): Promise<void> {
    if (!this.gatewayClient) return;

    this.isProcessing = true;
    this.streamedContent = '';
    this.chatLog.addUser(text);
    this.setStatus('sending to gateway...');
    this.tui.requestRender();

    try {
      await this.gatewayClient.sendMessage(text, this.sessionIdRef.current, this.config.agentId);
      this.setStatus('waiting for response...');
      this.tui.requestRender();
    } catch (err: any) {
      this.chatLog.addSystem(`❌ Send failed: ${err.message}`);
      this.isProcessing = false;
      this.setStatus('');
      this.tui.requestRender();
    }
  }

  // ── Submit ──

  private async handleSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    // /stop 可抢占：Run 在途仍允许发出
    if (this.isProcessing && !(trimmed === '/stop' || trimmed.startsWith('/stop '))) {
      this.chatLog.addSystem('Agent is busy — press Esc to abort or send /stop.');
      this.tui.requestRender();
      return;
    }

    if (trimmed === 'exit' || trimmed === 'quit') {
      this.requestExit();
      return;
    }

    // Client-local 命令：/clear /sessions /resume；其余交给引擎 CommandRouter
    if (await this.handleLocalCommand(trimmed)) return;

    await this.sendMessage(this.expandAttachments(trimmed));
  }

  /**
   * 展开消息里的 @path 文件引用（内联为附件文本）。
   *
   * @param text - 原消息文本
   * @returns 展开后的消息（失败引用保持原文并逐条提示）
   */
  private expandAttachments(text: string): string {
    const result = expandFileReferences(text, {
      readFileText: (path) => {
        try {
          return readFileSync(resolvePath(path), 'utf8');
        } catch {
          return null;
        }
      },
    });
    for (const item of result.failed) {
      const why =
        item.reason === 'binary'
          ? '二进制文件，未内联'
          : item.reason === 'over_budget'
            ? '超出附件总预算，未内联'
            : '文件不存在或不可读';
      this.chatLog.addSystem(`📎 ${item.path}: ${why}（引用保持原文）`);
    }
    for (const item of result.expanded) {
      if (item.truncated) {
        this.chatLog.addSystem(`📎 ${item.path}: 超长已截断（内联 ${item.chars} 字符）`);
      }
    }
    return result.text;
  }

  // ── Abort ──

  private abortProcessing(): void {
    this.gatewayClient?.sendAbort();
  }

  // ── Ctrl+C ──

  private handleCtrlC(): void {
    const now = Date.now();

    if (this.isProcessing) {
      this.abortProcessing();
      this.setStatus('press Ctrl+C again to exit');
      this.tui.requestRender();
      return;
    }

    const hasInput = this.editor.getText().trim().length > 0;
    if (hasInput) {
      this.editor.setText('');
      this.setStatus('input cleared; Ctrl+C again to exit');
      this.tui.requestRender();
      this.lastCtrlCAt = now;
      return;
    }

    if (now - this.lastCtrlCAt < 2000) {
      this.requestExit();
      return;
    }

    this.lastCtrlCAt = now;
    this.setStatus('press Ctrl+C again to exit');
    this.tui.requestRender();
  }

  // ── Reconnect（断线自动重连，指数退避） ──

  /**
   * 调度下一次重连。reconnectTimer 守卫去重：一次失败尝试可能同时经
   * connect() 的 reject 与 ws close 两条路径到达，只允许排一次。
   */
  private scheduleReconnect(): void {
    if (this.exitRequested || this.reconnectTimer) return;

    this.reconnectAttempts += 1;
    const plan = DEFAULT_RECONNECT_PLAN;
    if (this.reconnectAttempts > plan.maxAttempts) {
      this.chatLog.addSystem(
        `❌ 重连失败（连续 ${plan.maxAttempts} 次）。请检查 Gateway 后重新运行 octopi chat（--resume 可续接当前会话）`,
      );
      this.tui.requestRender();
      setTimeout(() => this.requestExit(), 1500);
      return;
    }
    const delayMs = reconnectDelay(this.reconnectAttempts, plan);
    const secs = Math.ceil(delayMs / 1000);
    this.chatLog.addSystem(
      `🔌 ${secs}s 后重连（第 ${this.reconnectAttempts}/${plan.maxAttempts} 次）…`,
    );
    this.setStatus(`reconnecting in ${secs}s…`);
    this.tui.requestRender();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect();
    }, delayMs);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.exitRequested || !this.gatewayClient) return;
    this.setStatus('reconnecting…');
    try {
      await this.gatewayClient.connect();
    } catch {
      // 失败由 close → onDisconnected → scheduleReconnect 统一驱动（去重），这里不重复排
      return;
    }
    this.reconnectAttempts = 0;
    this.setStatus('');
    // 断线期间的事件已缺失（在途 run 后续事件恢复可见）；可 /resume 或 --resume 重新加载历史
    this.gatewayClient.subscribe(this.sessionIdRef.current, this.config.agentId);
    this.tui.requestRender();
  }

  // ── Exit ──

  private requestExit(): void {
    this.exitRequested = true;
    this.gatewayClient?.disconnect();
    this.exitResolve?.();
  }

  private forceExit(): void {
    this.gatewayClient?.disconnect();
    this.tui.stop();
    process.exit(0);
  }

  // ── Editor ──

  private setupEditorAutocomplete(): void {
    const clientCommands: SlashCommand[] = [
      { name: 'clear', description: 'Clear screen' },
      { name: 'sessions', description: 'List recent sessions' },
      { name: 'resume', description: 'Resume session: /resume <n|id>' },
      { name: 'issues', description: 'System issues: /issues <n|id>' },
      { name: 'find', description: 'Search history: /find <query>' },
    ];
    const engineCommands: SlashCommand[] = this.commandCatalog.length
      ? this.commandCatalog
      : [
          { name: 'help', description: 'Show help' },
          { name: 'stop', description: 'Stop the active run' },
          { name: 'new', description: 'Start a new session' },
          { name: 'issues', description: 'List system issues' },
        ];
    const clientNames = new Set(clientCommands.map((c) => c.name));
    const slashCommands: SlashCommand[] = [
      ...clientCommands,
      ...engineCommands.filter((c) => !clientNames.has(c.name)),
    ];

    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(slashCommands, process.cwd()),
    );
  }

  private setupEditor(): void {
    this.setupEditorAutocomplete();

    this.editor.onSubmit = (text: string) => this.handleSubmit(text);
    this.editor.onEscape = () => {
      if (this.isProcessing) this.abortProcessing();
    };
    this.editor.onCtrlC = () => this.handleCtrlC();
    this.editor.onCtrlD = () => this.requestExit();
    this.editor.onCtrlO = () => {
      this.toolsExpanded = !this.toolsExpanded;
      this.chatLog.setToolsExpanded(this.toolsExpanded);
      this.setStatus(this.toolsExpanded ? 'tools expanded' : 'tools collapsed');
      this.tui.requestRender();
    };
    this.editor.onCtrlL = () => {
      this.chatLog.clear();
      this.tui.requestRender();
    };
  }

  private setupInputHandler(): void {
    this.tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+c') && this.exitRequested) {
        this.forceExit();
        return { consume: true };
      }
    });
  }

  // ── UI ──

  private updateHeader(): void {
    const title = `🐙 Octopi — ${this.currentModel || this.config.agentId} — 🌐 gateway`;
    this.header.setText(theme.header(title));
  }

  private updateFooter(): void {
    const parts = [
      `agent ${this.config.agentId}`,
      this.currentModel ? `model ${this.currentModel}` : '',
      this.contextWindow > 0
        ? `ctx ${this.formatTokens(this.contextTokens)} / ${this.formatTokens(this.contextWindow)}`
        : '',
      `gateway ${this.config.gatewayUrl}`,
      'Ctrl+C exit | Ctrl+O tools | /help',
    ].filter(Boolean);
    this.footer.setText(theme.footer(parts.join(' | ')));
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  private setStatus(text: string): void {
    this.statusText.setText(text ? theme.statusBusy(`  ${text}`) : '');
  }
}
