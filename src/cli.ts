#!/usr/bin/env node

/**
 * Octopi — 多协议 LLM Agent 框架
 *
 * 框架的命令行入口。支持以下命令：
 *
 * - serve: 启动 Gateway 服务
 * - chat: 交互式聊天（通过 HTTP 或直接调用 Agent Loop）
 * - health: 健康检查
 *
 * 使用方式：
 * ```bash
 * # 启动服务
 * npx octopi serve --config ./octopi.json
 *
 * # 交互式聊天
 * npx octopi chat --config ./octopi.json
 *
 * # 健康检查
 * npx octopi health --config ./octopi.json
 * ```
 */

import { loadConfig, toGatewayConfig } from './config.js';
import { resolve, dirname } from 'node:path';
import { Gateway } from './gateway/gateway.js';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { getBuiltinTools } from './tools/builtin.js';
import { createInterface } from 'node:readline';
import type { LLMProvider } from './core/types.js';
import type { ProviderConfig } from './config.js';

// ================================================================
// Provider 工厂
// ================================================================

function createProvider(cfg: ProviderConfig): LLMProvider | null {
  if (!cfg.apiKey) return null;

  if (cfg.type === 'anthropic') {
    return new AnthropicProvider({
      name: cfg.name,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      models: cfg.models,
      defaultModel: cfg.defaultModel,
    });
  }

  return new OpenAIProvider({
    name: cfg.name,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    models: cfg.models,
    defaultModel: cfg.defaultModel,
  });
}

// ================================================================
// 参数解析
// ================================================================

interface CliArgs {
  command: string;
  config?: string;
  port?: number;
  help?: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { command: args[0] ?? 'help' };

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--config':
      case '-c':
        result.config = args[++i];
        break;
      case '--port':
      case '-p':
        result.port = parseInt(args[++i], 10);
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
    }
  }

  return result;
}

// ================================================================
// 命令实现
// ================================================================

function showHelp(): void {
  console.log(`
Octopi — AI Agent Framework

Usage:
  octopi <command> [options]

Commands:
  serve     Start the Gateway server
  chat      Interactive chat with an agent
  health    Check the health of configured providers
  help      Show this help message

Options:
  --config, -c <path>   Config file path (default: ./octopi.json)
  --port, -p <port>     Port override
  --help, -h            Show this help message

Examples:
  octopi serve -c ./my-config.json
  octopi chat -c ./my-config.json
  octopi health -c ./my-config.json
`);
}

async function serveCommand(args: CliArgs): Promise<void> {
  const config = loadConfig(args.config);
  const gatewayConfig = toGatewayConfig(config);

  if (args.port) gatewayConfig.port = args.port;

  const gateway = new Gateway(gatewayConfig);

  for (const providerCfg of config.providers ?? []) {
    const provider = createProvider(providerCfg);
    if (provider) {
      gateway.registerProvider(provider);
      console.log(`[CLI] Registered provider: ${providerCfg.name} (${providerCfg.type})`);
    }
  }

  for (const tool of getBuiltinTools()) gateway.registerTool(tool);

  const httpConfig = config.channels?.find((c) => c.type === 'http');
  if (httpConfig) {
    const { HttpChannelAdapter } = await import('./protocol/http.js');
    gateway.registerChannel(new HttpChannelAdapter({
      port: httpConfig.port ?? args.port ?? 3000,
      path: httpConfig.path ?? '/messages',
    }));
  }

  process.on('SIGINT', async () => {
    console.log('\n[CLI] Shutting down...');
    await gateway.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[CLI] Shutting down...');
    await gateway.stop();
    process.exit(0);
  });

  await gateway.start();
}

async function chatCommand(args: CliArgs): Promise<void> {
  const config = loadConfig(args.config);
  const agent = config.agents[0];
  if (!agent) {
    console.error('[Error] No agents defined in config');
    process.exit(1);
  }

  // 解析 workspace 为绝对路径
  const configDir = args.config ? resolve(dirname(args.config)) : process.cwd();
  if (agent.workspace && !agent.workspace.startsWith('/')) {
    agent.workspace = resolve(configDir, agent.workspace);
  }

  const providerCfg = config.providers?.find((p) => p.name === agent.model.provider);
  if (!providerCfg) {
    console.error(`[Error] Provider "${agent.model.provider}" not found`);
    process.exit(1);
  }

  const provider = createProvider(providerCfg);
  if (!provider) {
    console.error(`[Error] Provider "${providerCfg.name}" requires apiKey`);
    process.exit(1);
  }

  const { AgentRunner } = await import('./agent/agent-runner.js');
  const loop = new AgentRunner();
  loop.registerProvider(provider);
  for (const tool of getBuiltinTools()) loop.registerTool(tool);

  // 进度显示状态
  let hasShownThinking = false;
  let streamedContent = '';

  // 事件监听器：实时显示进度
  loop.on((event) => {
    switch (event.type) {
      case 'llm_request':
        if (!hasShownThinking) {
          process.stdout.write('  🤔 Thinking...');
          hasShownThinking = true;
        }
        break;

      case 'llm_stream_delta':
        // 流式输出：清除 Thinking 后直接打印增量
        if (event.delta) {
          if (hasShownThinking) {
            process.stdout.write('\r' + ' '.repeat(20) + '\r'); // 清除 "Thinking..."
            hasShownThinking = false;
          }
          process.stdout.write(event.delta);
          streamedContent += event.delta;
        }
        break;

      case 'tool_call_start':
        process.stdout.write(`\n  🔧 Running: ${event.toolName}...\n`);
        break;

      case 'tool_call_result':
        process.stdout.write(`  ✅ Done (${event.durationMs}ms)\n`);
        break;

      case 'llm_response':
        // 最终响应完成（纯文本回复时）
        if (!event.toolCalls) {
          if (streamedContent) {
            process.stdout.write('\n'); // 流式输出结束，换行
          } else if (event.content) {
            // 非流式输出
            console.log(`\n  ${event.content}`);
          }
        }
        break;

      case 'error':
        console.error(`\n  ❌ Error: ${event.error?.message ?? 'Unknown'}`);
        break;
    }
  });

  const mockMsg = {
    id: 'cli',
    channel: 'cli',
    senderId: 'user',
    senderName: 'User',
    content: '',
    conversationId: 'cli-session',
    timestamp: Date.now(),
  };
  const session = loop.resolveSession(agent, mockMsg, config.session?.dmScope ?? 'main');

  console.log(`\n🐙 Octopi Chat`);
  console.log(`   Agent: ${agent.persona.name}`);
  console.log(`   Model: ${providerCfg.type} / ${agent.model.model}`);
  console.log(`   Type "exit" or "quit" to end\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed) { ask(); return; }
      if (trimmed === 'exit' || trimmed === 'quit') {
        console.log('Goodbye! 👋');
        await loop.close();
        rl.close();
        return;
      }

      try {
        mockMsg.content = trimmed;
        mockMsg.timestamp = Date.now();
        hasShownThinking = false;
        streamedContent = '';

        const reply = await loop.processMessage(agent, session, mockMsg);
        // 最终回复已通过事件监听器输出，这里只输出 agent 名前缀
        console.log(`\n${agent.persona.name}: ${reply.content}\n`);
      } catch (error) {
        console.error(`\n[Error] ${error instanceof Error ? error.message : String(error)}\n`);
      }

      ask();
    });
  };

  ask();
}

async function healthCommand(args: CliArgs): Promise<void> {
  const config = loadConfig(args.config);
  const { LLMRouter } = await import('./providers/router.js');
  const router = new LLMRouter();

  for (const providerCfg of config.providers ?? []) {
    const provider = createProvider(providerCfg);
    if (provider) router.register(provider);
  }

  console.log('\n🏥 Health Check\n');
  const results = await router.healthCheckAll();
  for (const [name, ok] of Object.entries(results)) {
    console.log(`  ${name}: ${ok ? '✅ OK' : '❌ FAIL'}`);
  }
  console.log();
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help || args.command === 'help') {
    showHelp();
    return;
  }

  switch (args.command) {
    case 'serve': await serveCommand(args); break;
    case 'chat': await chatCommand(args); break;
    case 'health': await healthCommand(args); break;
    default:
      console.error(`Unknown command: ${args.command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[Fatal] ${error.message}`);
  process.exit(1);
});
