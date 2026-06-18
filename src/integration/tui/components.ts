/**
 * Octopi TUI Components
 *
 * 基于 pi-tui 的自定义组件：ChatLog、消息组件、工具执行组件。
 */

import {
  Container,
  Text,
  Spacer,
  Markdown,
  Box,
  type Component,
} from '@earendil-works/pi-tui';
import { theme, markdownTheme } from './theme.js';

// ── Constants ──

const PREVIEW_LINES = 8;

// ── UserMessageComponent ──

export class UserMessageComponent extends Container {
  private body: Markdown;

  constructor(text: string) {
    super();
    this.body = new Markdown(text, 1, 1, markdownTheme, {
      color: (line: string) => theme.userText(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.userPrefix(), 1, 0));
    this.addChild(this.body);
  }

  setText(text: string): void {
    this.body = new Markdown(text, 1, 1, markdownTheme, {
      color: (line: string) => theme.userText(line),
    });
    // Replace children
    this.clear();
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.userPrefix(), 1, 0));
    this.addChild(this.body);
  }
}

// ── AssistantMessageComponent ──

export class AssistantMessageComponent extends Container {
  private body: Markdown;
  private currentText: string;

  constructor(text: string = '') {
    super();
    this.currentText = text;
    this.body = new Markdown(text, 1, 1, markdownTheme, {
      color: (line: string) => theme.assistantText(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.assistantPrefix(), 1, 0));
    this.addChild(this.body);
  }

  setText(text: string): void {
    this.currentText = text;
    this.body = new Markdown(text, 1, 1, markdownTheme, {
      color: (line: string) => theme.assistantText(line),
    });
    this.clear();
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.assistantPrefix(), 1, 0));
    this.addChild(this.body);
  }
}

// ── ToolExecutionComponent ──

export class ToolExecutionComponent extends Container {
  private toolName: string;
  private args: string;
  private result: string | null = null;
  private expanded = false;
  private isPartial = true;
  private isError = false;
  private box: Box;
  private header: Text;
  private argsLine: Text;
  private output: Markdown;

  constructor(toolName: string, args: string) {
    super();
    this.toolName = toolName;
    this.args = args;
    this.box = new Box(1, 1, (line: string) => theme.toolPendingBg(line));
    this.header = new Text('', 0, 0);
    this.argsLine = new Text('', 0, 0);
    this.output = new Markdown('', 0, 0, markdownTheme, {
      color: (line: string) => theme.toolOutput(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.box);
    this.box.addChild(this.header);
    this.box.addChild(this.argsLine);
    this.box.addChild(this.output);
    this.refresh();
  }

  setArgs(args: string): void {
    this.args = args;
    this.refresh();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.refresh();
  }

  setResult(result: string, opts?: { isError?: boolean }): void {
    this.result = result;
    this.isPartial = false;
    this.isError = Boolean(opts?.isError);
    this.refresh();
  }

  setPartialResult(result: string): void {
    this.result = result;
    this.isPartial = true;
    this.refresh();
  }

  private refresh(): void {
    const bg = this.isPartial
      ? theme.toolPendingBg
      : this.isError
        ? theme.toolErrorBg
        : theme.toolSuccessBg;
    this.box.setBgFn((line: string) => bg(line));

    const emoji = this.isError ? '❌' : this.isPartial ? '⏳' : '✅';
    const status = this.isPartial ? ' (running)' : this.isError ? ' (failed)' : '';
    const title = `${emoji} ${this.toolName}${status}`;
    this.header.setText(theme.toolTitle(theme.bold(title)));

    this.argsLine.setText(this.args ? theme.toolDim(this.args) : theme.toolDim(' '));

    const text = this.result || (this.isPartial ? '…' : '');
    if (!this.expanded && text) {
      const lines = text.split('\n');
      const preview = lines.length > PREVIEW_LINES
        ? `${lines.slice(0, PREVIEW_LINES).join('\n')}\n…`
        : text;
      this.output.setText(preview);
    } else {
      this.output.setText(text);
    }
  }
}

// ── SystemMessageComponent ──

export class SystemMessageComponent extends Container {
  private textNode: Text;
  private baseText: string;
  private count: number;

  constructor(text: string) {
    super();
    this.baseText = text;
    this.count = 1;
    this.textNode = new Text(theme.system(text), 1, 0);
    this.addChild(new Spacer(1));
    this.addChild(this.textNode);
  }

  increment(): void {
    this.count++;
    this.textNode.setText(theme.system(this.count > 1 ? `${this.baseText} x${this.count}` : this.baseText));
  }
}

// ── ChatLog ──

/**
 * 滚动聊天日志容器。
 *
 * 跟踪：用户消息、助手消息（流式/最终）、工具执行、系统通知。
 * 自动裁剪超过 maxComponents 的旧消息。
 */
export class ChatLog extends Container {
  private toolById = new Map<string, ToolExecutionComponent>();
  private streamingRuns = new Map<string, AssistantMessageComponent>();
  private maxComponents: number;
  private toolsExpanded = false;
  private lastSystemMessage: SystemMessageComponent | null = null;

  constructor(maxComponents = 180) {
    super();
    this.maxComponents = Math.max(20, Math.floor(maxComponents));
  }

  private dropComponentReferences(component: Component): void {
    for (const [id, tool] of this.toolById.entries()) {
      if (tool === component) this.toolById.delete(id);
    }
    for (const [id, msg] of this.streamingRuns.entries()) {
      if (msg === component) this.streamingRuns.delete(id);
    }
  }

  private pruneOverflow(): void {
    while (this.children.length > this.maxComponents) {
      const oldest = this.children[0];
      if (!oldest) return;
      this.removeChild(oldest);
      this.dropComponentReferences(oldest);
    }
  }

  append(component: Component): void {
    this.addChild(component);
    this.pruneOverflow();
  }

  appendNonSystem(component: Component): void {
    this.lastSystemMessage = null;
    this.append(component);
  }

  clearAll(): void {
    this.clear();
    this.toolById.clear();
    this.streamingRuns.clear();
    this.lastSystemMessage = null;
  }

  clearTools(): void {
    for (const tool of this.toolById.values()) this.removeChild(tool);
    this.toolById.clear();
  }

  setToolsExpanded(expanded: boolean): void {
    this.toolsExpanded = expanded;
    for (const tool of this.toolById.values()) tool.setExpanded(expanded);
  }

  // ── System Messages ──

  addSystem(text: string, opts?: { coalesceConsecutive?: boolean }): void {
    if (
      opts?.coalesceConsecutive &&
      this.lastSystemMessage &&
      this.children[this.children.length - 1] === this.lastSystemMessage
    ) {
      this.lastSystemMessage.increment();
      return;
    }
    const msg = new SystemMessageComponent(text);
    this.append(msg);
    this.lastSystemMessage = opts?.coalesceConsecutive ? msg : null;
  }

  // ── User Messages ──

  addUser(text: string): void {
    this.appendNonSystem(new UserMessageComponent(text));
  }

  // ── Assistant Messages (streaming) ──

  startAssistant(text: string, runId: string = 'default'): AssistantMessageComponent {
    const existing = this.streamingRuns.get(runId);
    if (existing) {
      existing.setText(text);
      return existing;
    }
    const component = new AssistantMessageComponent(text);
    this.streamingRuns.set(runId, component);
    this.appendNonSystem(component);
    return component;
  }

  updateAssistant(text: string, runId: string = 'default'): void {
    const existing = this.streamingRuns.get(runId);
    if (!existing) {
      this.startAssistant(text, runId);
      return;
    }
    existing.setText(text);
  }

  finalizeAssistant(text: string, runId: string = 'default'): void {
    const existing = this.streamingRuns.get(runId);
    if (existing) {
      existing.setText(text);
      this.streamingRuns.delete(runId);
      return;
    }
    this.appendNonSystem(new AssistantMessageComponent(text));
  }

  dropAssistant(runId: string = 'default'): void {
    const existing = this.streamingRuns.get(runId);
    if (!existing) return;
    this.removeChild(existing);
    this.streamingRuns.delete(runId);
  }

  // ── Tool Execution ──

  startTool(toolCallId: string, toolName: string, args: string): ToolExecutionComponent {
    const existing = this.toolById.get(toolCallId);
    if (existing) {
      existing.setArgs(args);
      return existing;
    }
    const component = new ToolExecutionComponent(toolName, args);
    component.setExpanded(this.toolsExpanded);
    this.toolById.set(toolCallId, component);
    this.appendNonSystem(component);
    return component;
  }

  updateToolArgs(toolCallId: string, args: string): void {
    this.toolById.get(toolCallId)?.setArgs(args);
  }

  updateToolResult(toolCallId: string, result: string, opts?: { isError?: boolean }): void {
    this.toolById.get(toolCallId)?.setResult(result, opts);
  }
}
