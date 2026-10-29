/**
 * Octopi TUI App
 *
 * 纯 Gateway 客户端模式。
 * TUI 只负责 UI 渲染和事件展示，所有引擎逻辑在 Gateway 侧。
 */

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
  private openIssues: Array<{ id: string; severity: string; title: string; detail: string }> = [];

  private sessionIdRef = { current: '' };
  private toolsExpanded = false;
  private lastCtrlCAt = 0;
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
          this.isProcessing = false;
          this.setStatus('disconnected');
        }
        this.tui.requestRender();
        // 断连后自动退出，用户重新运行 octopi chat
        if (!this.exitRequested) {
          this.chatLog.addSystem('Connection lost. Exiting...');
          this.tui.requestRender();
          setTimeout(() => this.requestExit(), 1500);
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
        const issue = event.data?.issue as { title?: string; detail?: string; severity?: string } | undefined;
        if (issue?.title) {
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

      case 'context.truncated': {
        const data = event.data as any;
        this.chatLog.addSystem(`✂️ Context truncated (${data?.from} → ${data?.to} messages)`);
        this.tui.requestRender();
        break;
      }

      // 其他事件静默忽略
    }
  }

  // ── Client-local Commands（/clear /sessions /resume） ──

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
    return false;
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

  /** 拉取最近历史（backward 翻页，最多 3 页 × 200 条）并渲染进 ChatLog */
  private async loadHistory(sessionId: string): Promise<void> {
    const collected: Array<Message & { index: number }> = [];
    let cursor: string | undefined;
    let total = 0;
    for (let page = 0; page < 3; page++) {
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
    this.chatLog.clearAll();
    this.renderHistoryEntries(toChatEntries(collected));
    this.chatLog.addSystem(
      `🐙 Session → ${sessionId}（已加载最近 ${collected.length}/${total} 条消息）`,
    );
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

    await this.sendMessage(trimmed);
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
