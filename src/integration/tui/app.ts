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
import type { AgentEvent } from '../../core/primitives/event-bus.js';
import { GatewayChatClient } from '../gateway/client.js';

// ── Types ──

export interface TuiAppConfig {
  agentId: string;
  /** Gateway URL（如 http://localhost:3000） */
  gatewayUrl: string;
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
  private currentModel = '';

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
    this.gatewayClient = new GatewayChatClient({ url: this.config.gatewayUrl });

    this.gatewayClient.on({
      onEvent: (event) => this.handleAgentEvent(event),
      onConnected: () => {
        this.chatLog.addSystem('✅ Connected to Gateway');
        this.tui.requestRender();
      },
      onGatewayInfo: (info) => {
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
        this.chatLog.clearTransientSystem();
        if (this.streamedContent || content) {
          this.chatLog.finalizeAssistant(this.streamedContent || content, 'run');
        } else if (hasToolCalls) {
          // 工具执行回合：无文本内容是正常的，不显示警告
          this.chatLog.dropAssistant('run');
        } else {
          this.chatLog.dropAssistant('run');
          this.chatLog.addSystem('⚠️ Empty response.');
        }
        this.streamedContent = '';
        this.isProcessing = false;

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

        this.setStatus('');
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

      case 'loop_detected': {
        const data = event.data as any;
        const icon = data?.level === 'critical' ? '🛑' : '🔄';
        this.chatLog.addSystem(`${icon} Loop detected: ${data?.message}`);
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

    if (this.isProcessing) {
      this.chatLog.addSystem('Agent is busy — press Esc to abort.');
      this.tui.requestRender();
      return;
    }

    if (trimmed === 'exit' || trimmed === 'quit') {
      this.requestExit();
      return;
    }

    // Slash commands
    if (trimmed === '/help') {
      this.chatLog.addSystem([
        'Commands:',
        '  /help     Show this help',
        '  /new      Start a new session',
        '  /clear    Clear screen',
        '  exit      Exit TUI',
        '',
        'Keys:',
        '  Ctrl+C    Abort / clear / exit',
        '  Ctrl+D    Exit',
        '  Ctrl+L    Clear screen',
        '  Ctrl+O    Toggle tool details',
        '  Esc       Abort current run',
      ].join('\n'));
      this.tui.requestRender();
      return;
    }

    if (trimmed === '/clear') {
      this.chatLog.clear();
      this.tui.requestRender();
      return;
    }

    if (trimmed === '/new') {
      this.sessionIdRef.current = `${this.config.agentId}:cli:${Date.now()}`;
      this.streamedContent = '';
      this.chatLog.clear();
      this.chatLog.addSystem('🐙 New session started.');
      this.tui.requestRender();
      return;
    }

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

  private setupEditor(): void {
    const slashCommands: SlashCommand[] = [
      { name: 'help', description: 'Show help' },
      { name: 'new', description: 'Start a new session' },
      { name: 'clear', description: 'Clear screen' },
      { name: 'exit', description: 'Exit TUI' },
      { name: 'quit', description: 'Exit TUI' },
    ];

    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(slashCommands, process.cwd()),
    );

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
