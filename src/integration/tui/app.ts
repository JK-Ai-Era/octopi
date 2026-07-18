/**
 * Octopi TUI App
 *
 * 主 TUI 应用程序。支持双模式：
 * - Gateway 模式：连接 Gateway WebSocket，共享 session/provider
 * - 本地模式：直接创建 AgentEngine（Gateway 未启动时）
 */

import {
  TUI,
  Text,
  Editor,
  ProcessTerminal,
  Container,
  Spacer,
  Key,
  matchesKey,
  isKeyRelease,
  CombinedAutocompleteProvider,
} from '@earendil-works/pi-tui';
import { theme, editorTheme } from './theme.js';
import { ChatLog } from './components.js';
import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type { SessionStore } from '../../core/interfaces/session-store.js';
import type { RegisteredTool, AgentDefinition } from '../../core/types.js';
import type { AgentEvent } from '../../core/event-bus.js';
import type { RunConfig } from '../../core/engine.js';
import { AgentBuilder } from '../../harness/builder.js';
import { SessionAwareRunner } from '../../harness/runner.js';
import { CommandPlugin } from '../../harness/commands/index.js';
import { getBuiltinTools } from '../../harness/tools/builtin.js';
import type { TaskSupervisorConfig } from '../../harness/supervisor/task-supervisor.js';
import { GatewayChatClient } from '../gateway/client.js';

// ── Types ──

export interface TuiAppConfig {
  agentId: string;
  model: string;
  provider: ModelProvider;
  store: SessionStore;
  systemPrompt?: string;
  personaPath?: string;
  tools?: RegisteredTool[];
  budget?: any;
  supervisor?: TaskSupervisorConfig;
  workspace?: string;
  /** Gateway URL（如 http://localhost:3000）。不传则本地模式。 */
  gatewayUrl?: string;
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

  // 本地模式
  private runner: SessionAwareRunner | null = null;
  // Gateway 模式
  private gatewayClient: GatewayChatClient | null = null;
  private useGateway = false;

  private commands!: CommandPlugin;

  private sessionIdRef = { current: '' };
  private currentModelRef = { current: '' };
  private toolsExpanded = false;
  private lastCtrlCAt = 0;
  private exitRequested = false;
  private isProcessing = false;
  private streamedContent = '';
  private abortController: AbortController | null = null;

  constructor(config: TuiAppConfig) {
    this.config = config;
    this.currentModelRef.current = config.model;
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
    // 检测 Gateway
    if (this.config.gatewayUrl) {
      const available = await GatewayChatClient.detect(this.config.gatewayUrl);
      if (available) {
        await this.startGatewayMode();
      } else {
        this.chatLog.addSystem(`⚠️ Gateway not reachable at ${this.config.gatewayUrl}, falling back to local mode.`);
        await this.startLocalMode();
      }
    } else {
      await this.startLocalMode();
    }

    this.setupCommands();
    this.setupEditor();
    this.setupInputHandler();
    this.updateHeader();
    this.updateFooter();

    this.chatLog.addSystem(`🐙 Octopi Chat — ${this.currentModelRef.current}`);
    const mode = this.useGateway ? 'gateway' : 'local';
    this.chatLog.addSystem(`Mode: ${mode} | Type /help for commands, Ctrl+C to exit.`);
    this.tui.requestRender();

    this.tui.start();

    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.exitRequested) resolve();
        else setTimeout(check, 100);
      };
      check();
    });

    this.tui.stop();
  }

  // ── Gateway Mode ──

  private async startGatewayMode(): Promise<void> {
    this.useGateway = true;
    this.gatewayClient = new GatewayChatClient({ url: this.config.gatewayUrl! });

    this.gatewayClient.on({
      onEvent: (event) => this.handleAgentEvent(event),
      onConnected: () => {
        this.chatLog.addSystem('✅ Connected to Gateway');
        // 从 Gateway 获取实际配置
        const gwInfo = this.gatewayClient?.gatewayInfo;
        if (gwInfo?.agents?.length) {
          const agent = gwInfo.agents.find(a => a.id === this.config.agentId) ?? gwInfo.agents[0];
          if (agent?.model?.model) {
            this.currentModelRef.current = agent.model.model;
            this.updateHeader();
          }
        }
        this.tui.requestRender();
      },
      onDisconnected: (reason) => {
        this.chatLog.addSystem(`❌ Disconnected from Gateway: ${reason ?? 'unknown'}`);
        // 断连时重置处理状态，否则 Ctrl+C 无法正常退出
        if (this.isProcessing) {
          if (this.streamedContent) {
            this.chatLog.finalizeAssistant(this.streamedContent + '\n\n*(connection lost)*', 'run');
          }
          this.isProcessing = false;
          this.abortController = null;
          this.setStatus('disconnected');
        }
        this.tui.requestRender();
      },
      onError: (err) => {
        this.chatLog.addSystem(`⚠️ Gateway error: ${err.message}`);
        this.tui.requestRender();
      },
    });

    try {
      await this.gatewayClient.connect();
    } catch (err: any) {
      this.chatLog.addSystem(`⚠️ Failed to connect to Gateway: ${err.message}`);
      this.chatLog.addSystem('Falling back to local mode.');
      this.useGateway = false;
      this.gatewayClient = null;
      await this.startLocalMode();
    }
  }

  // ── Local Mode ──

  private async startLocalMode(): Promise<void> {
    const builder = new AgentBuilder()
      .model(this.config.provider)
      .store(this.config.store);

    if (this.config.systemPrompt) {
      builder.systemPrompt(this.config.systemPrompt);
    } else if (this.config.personaPath) {
      builder.persona(this.config.personaPath);
    }

    for (const tool of getBuiltinTools()) builder.tool(tool);
    for (const tool of this.config.tools ?? []) builder.tool(tool);

    if (this.config.budget) builder.budget(this.config.budget);

    if (this.config.supervisor?.enabled !== false) {
      builder.taskSupervisor(this.config.supervisor ?? {});
    }

    const { runner } = await builder.build();
    this.runner = runner;
  }

  // ── Commands ──

  private setupCommands(): void {
    this.commands = new CommandPlugin({
      sessionIdRef: this.sessionIdRef,
      currentModelRef: this.currentModelRef,
      onNewSession: () => `${this.config.agentId}:cli:${Date.now()}`,
    });

    const slashCommands: SlashCommand[] = [];
    for (const [name, def] of this.commands.getCommands()) {
      slashCommands.push({ name: name.replace(/^\//, ''), description: def.description });
    }
    slashCommands.push({ name: 'exit', description: 'Exit the TUI' });
    slashCommands.push({ name: 'quit', description: 'Exit the TUI' });

    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(slashCommands, process.cwd()),
    );
  }

  // ── Editor ──

  private setupEditor(): void {
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
  }

  private setupInputHandler(): void {
    this.tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+c') && this.exitRequested) {
        this.forceExit();
        return { consume: true };
      }
    });
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

    if (trimmed.startsWith('/')) {
      const cmdResult = await this.commands.tryExecute(trimmed, this.sessionIdRef.current, this.config.agentId);
      if (cmdResult) {
        if (cmdResult.message) this.chatLog.addSystem(cmdResult.message);
        this.tui.requestRender();
        return;
      }
    }

    if (this.useGateway) {
      await this.sendViaGateway(trimmed);
    } else {
      await this.sendLocal(trimmed);
    }
  }

  // ── Gateway Send ──

  private async sendViaGateway(text: string): Promise<void> {
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
      // 事件通过 onEvent 回调异步到达
    } catch (err: any) {
      this.chatLog.addSystem(`❌ Send failed: ${err.message}`);
      this.isProcessing = false;
      this.setStatus('');
      this.tui.requestRender();
    }
  }

  // ── Gateway Event Handler ──

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
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

      case 'turn.end': {
        const content = (event.data?.content as string) ?? '';
        if (this.streamedContent || content) {
          this.chatLog.finalizeAssistant(this.streamedContent || content, 'run');
        } else {
          this.chatLog.dropAssistant('run');
          this.chatLog.addSystem('⚠️ Empty response.');
        }
        this.isProcessing = false;
        this.setStatus('');
        this.tui.requestRender();
        break;
      }

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

      case 'budget.exceeded': {
        const report = event.data as any;
        if (this.streamedContent) this.chatLog.finalizeAssistant(this.streamedContent, 'run');
        this.chatLog.addSystem(`⛔ Budget exceeded: ${report?.status ?? 'unknown'}`);
        this.isProcessing = false;
        this.setStatus('');
        this.tui.requestRender();
        break;
      }

      case 'engine.error': {
        const errorData = event.data as any;
        this.chatLog.dropAssistant('run');
        this.chatLog.addSystem(`❌ Engine error: ${errorData?.error ?? 'unknown'}`);
        this.isProcessing = false;
        this.setStatus('');
        this.tui.requestRender();
        break;
      }

      case 'aborted': {
        const reason = event.data?.reason as string;
        if (this.streamedContent) this.chatLog.finalizeAssistant(this.streamedContent, 'run');
        this.chatLog.addSystem(`🛑 Aborted: ${reason ?? 'unknown'}`);
        this.isProcessing = false;
        this.setStatus('');
        this.tui.requestRender();
        break;
      }

      case 'engine.end': {
        // 安全网：确保 isProcessing 被重置，即使 turn.end 未被收到
        if (this.isProcessing) {
          if (this.streamedContent) {
            this.chatLog.finalizeAssistant(this.streamedContent, 'run');
          } else {
            // 引擎退出但没有任何内容 → 给用户提示
            this.chatLog.addSystem('⚠️ Agent ended without a response.');
          }
          this.isProcessing = false;
          this.setStatus('');
          this.tui.requestRender();
        }
        break;
      }
    }
  }

  // ── Local Send ──

  private async sendLocal(text: string): Promise<void> {
    if (!this.runner) return;

    this.isProcessing = true;
    this.streamedContent = '';
    this.abortController = new AbortController();

    this.chatLog.addUser(text);
    this.setStatus('thinking...');
    this.tui.requestRender();

    const userMessage = {
      role: 'user' as const,
      content: text,
      timestamp: Date.now(),
    };

    const runConfig: RunConfig = {
      agentId: this.config.agentId,
      sessionId: this.sessionIdRef.current,
      model: this.currentModelRef.current,
      systemPrompt: this.config.systemPrompt ?? '',
      cwd: this.config.workspace,
    };

    let hasShownAssistant = false;
    let finalContent = '';

    try {
      const eventStream = this.runner.handle(
        this.sessionIdRef.current,
        userMessage,
        runConfig,
        this.abortController.signal,
      );

      for await (const event of eventStream) {
        if (this.exitRequested) break;

        switch (event.type) {
          case 'model.call.start':
            if (!hasShownAssistant) {
              this.setStatus('calling model...');
              this.tui.requestRender();
            }
            break;

          case 'model.call.error': {
            const errorData = event.data?.error as any;
            const reason = errorData?.reason ?? errorData?.message ?? 'unknown';
            const statusCode = errorData?.statusCode;
            const detail = statusCode ? ` (HTTP ${statusCode})` : '';
            this.chatLog.addSystem(`❌ Model error: ${reason}${detail}`);
            this.tui.requestRender();
            break;
          }

          case 'retry': {
            const delayMs = event.data?.delayMs as number;
            this.chatLog.addSystem(`🔄 Retrying in ${delayMs}ms...`);
            this.tui.requestRender();
            break;
          }

          case 'aborted': {
            const reason = event.data?.reason as string;
            if (hasShownAssistant) this.chatLog.finalizeAssistant(this.streamedContent || finalContent, 'run');
            this.chatLog.addSystem(`🛑 Aborted: ${reason ?? 'model error'}`);
            this.tui.requestRender();
            break;
          }

          case 'llm_stream_delta': {
            const delta = event.data?.delta as string;
            if (delta) {
              if (!hasShownAssistant) {
                this.chatLog.startAssistant('', 'run');
                hasShownAssistant = true;
                this.setStatus('streaming...');
              }
              this.streamedContent += delta;
              this.chatLog.updateAssistant(this.streamedContent, 'run');
              this.tui.requestRender();
            }
            break;
          }

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

          case 'turn.end':
            finalContent = (event.data?.content as string) ?? '';
            break;

          case 'budget.exceeded': {
            const report = event.data as any;
            if (hasShownAssistant) this.chatLog.finalizeAssistant(this.streamedContent || finalContent, 'run');
            this.chatLog.addSystem(`⛔ Budget exceeded: ${report?.status ?? 'unknown'}`);
            break;
          }

          case 'engine.error': {
            const errorData = event.data as any;
            if (hasShownAssistant) this.chatLog.dropAssistant('run');
            this.chatLog.addSystem(`❌ Engine error: ${errorData?.error ?? 'unknown'}`);
            break;
          }

          case 'context.truncated': {
            const data = event.data as any;
            this.chatLog.addSystem(`✂️ Context truncated (${data?.from} → ${data?.to} messages)`);
            break;
          }

          case 'planning_only_retry': {
            const data = event.data as any;
            this.chatLog.addSystem(`🔄 Planning-only, retrying (${data?.attempt}/${data?.maxAttempts})...`);
            break;
          }

          case 'checkpoint': {
            const data = event.data as any;
            if (data?.verdict?.action === 'recover') {
              this.chatLog.addSystem(`🔄 Checkpoint: ${data.verdict.reason}`);
            }
            break;
          }

          case 'checkpoint.stop': {
            const data = event.data as any;
            if (hasShownAssistant) this.chatLog.finalizeAssistant(this.streamedContent || finalContent, 'run');
            this.chatLog.addSystem(`🛑 Supervisor stopped: ${data?.reason ?? 'unknown'}`);
            break;
          }
        }
      }

      if (hasShownAssistant) {
        const displayContent = this.streamedContent || finalContent;
        if (displayContent) {
          this.chatLog.finalizeAssistant(displayContent, 'run');
        } else {
          this.chatLog.dropAssistant('run');
          this.chatLog.addSystem('⚠️ Empty response from model.');
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        if (hasShownAssistant) this.chatLog.finalizeAssistant(this.streamedContent || finalContent || '*(aborted)*', 'run');
        this.chatLog.addSystem('🛑 Aborted.');
      } else {
        if (hasShownAssistant) this.chatLog.dropAssistant('run');
        this.chatLog.addSystem(`❌ Error: ${error.message ?? String(error)}`);
      }
    } finally {
      this.isProcessing = false;
      this.abortController = null;
      this.setStatus('');
      this.tui.requestRender();
    }
  }

  // ── Abort ──

  private abortProcessing(): void {
    if (this.useGateway && this.gatewayClient) {
      this.gatewayClient.sendAbort();
    }
    if (this.abortController) {
      this.abortController.abort();
    }
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
    if (this.gatewayClient) this.gatewayClient.disconnect();
    if (this.abortController) this.abortController.abort();
  }

  private forceExit(): void {
    if (this.gatewayClient) this.gatewayClient.disconnect();
    this.tui.stop();
    process.exit(0);
  }

  // ── UI ──

  private updateHeader(): void {
    const mode = this.useGateway ? '🌐 gateway' : '💻 local';
    const title = `🐙 Octopi — ${this.currentModelRef.current} — ${mode}`;
    this.header.setText(theme.header(title));
  }

  private updateFooter(): void {
    const gwInfo = this.useGateway ? `gateway ${this.config.gatewayUrl}` : 'local';
    const cwd = this.config.workspace ?? process.cwd();
    const parts = [
      `agent ${this.config.agentId}`,
      `model ${this.currentModelRef.current}`,
      gwInfo,
      `cwd ${cwd}`,
      'Ctrl+C exit | Ctrl+O tools | /help',
    ];
    this.footer.setText(theme.footer(parts.join(' | ')));
  }

  private setStatus(text: string): void {
    this.statusText.setText(text ? theme.statusBusy(`  ${text}`) : '');
  }
}
