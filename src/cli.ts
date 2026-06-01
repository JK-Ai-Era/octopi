#!/usr/bin/env node

/**
 * Agent Harness CLI
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
 * npx agent-harness serve --config ./agent-harness.json
 *
 * # 交互式聊天
 * npx agent-harness chat --config ./agent-harness.json
 *
 * # 健康检查
 * npx agent-harness health --config ./agent-harness.json
 * ```
 */

import { loadConfig, toGatewayConfig } from './config.js';
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

/**
 * 根据配置创建 LLM Provider
 *
 * 支持两种协议：
 * - openai: OpenAI Chat Completions API（/v1/chat/completions）
 * - anthropic: Anthropic Messages API（/v1/messages）
 */
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

  // 默认 openai（包括所有 OpenAI 兼容的自定义 endpoint）
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
  const result: CliArgs = {
    command: args[0] ?? 'help',
  };

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
Agent Harness — AI Agent Framework

Usage:
  agent-harness <command> [options]

Commands:
  serve     Start the Gateway server
  chat      Interactive chat with an agent
  health    Check the health of configured providers
  help      Show this help message

Options:
  --config, -c <path>   Config file path (default: ./agent-harness.json)
  --port, -p <port>     Port override
  --help, -h            Show this help message

Supported provider types:
  openai      OpenAI Chat Completions API (/v1/chat/completions)
  anthropic   Anthropic Messages API (/v1/messages)

Examples:
  agent-harness serve -c ./my-config.json
  agent-harness chat -c ./my-config.json
  agent-harness health -c ./my-config.json
`);
}

async function serveCommand(args: CliArgs): Promise<void> {
  const config = loadConfig(args.config);
  const gatewayConfig = toGatewayConfig(config);

  if (args.port) {
    gatewayConfig.port = args.port;
  }

  const gateway = new Gateway(gatewayConfig);

  // 注册 providers（支持 OpenAI 和 Anthropic）
  for (const providerCfg of config.providers ?? []) {
    const provider = createProvider(providerCfg);
    if (provider) {
      gateway.registerProvider(provider);
      console.log(`[CLI] Registered provider: ${providerCfg.name} (${providerCfg.type})`);
    }
  }

  // 注册内置工具
  for (const tool of getBuiltinTools()) {
    gateway.registerTool(tool);
  }

  // 注册 HTTP channel
  const httpConfig = config.channels?.find((c) => c.type === 'http');
  if (httpConfig) {
    const { HttpChannelAdapter } = await import('./protocol/http.js');
    gateway.registerChannel(new HttpChannelAdapter({
      port: httpConfig.port ?? args.port ?? 3000,
      path: httpConfig.path ?? '/messages',
    }));
  }

  // 优雅关闭
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

  // 找到 provider 配置
  const providerCfg = config.providers?.find((p) => p.name === agent.model.provider);
  if (!providerCfg) {
    console.error(`[Error] Provider "${agent.model.provider}" not found in config`);
    process.exit(1);
  }

  const provider = createProvider(providerCfg);
  if (!provider) {
    console.error(`[Error] Provider "${providerCfg.name}" requires apiKey`);
    process.exit(1);
  }

  // 动态导入 AgentLoop
  const { AgentLoop } = await import('./agent/agent-loop.js');
  const loop = new AgentLoop();

  loop.registerProvider(provider);

  // 注册内置工具
  for (const tool of getBuiltinTools()) {
    loop.registerTool(tool);
  }

  // 创建 session
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

  console.log(`\n🤖 Agent Harness Chat`);
  console.log(`   Agent: ${agent.persona.name}`);
  console.log(`   Model: ${providerCfg.type} / ${agent.model.model}`);
  console.log(`   Type "exit" or "quit" to end the conversation\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = () => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        ask();
        return;
      }
      if (trimmed === 'exit' || trimmed === 'quit') {
        console.log('Goodbye! 👋');
        await loop.close();
        rl.close();
        return;
      }

      try {
        mockMsg.content = trimmed;
        mockMsg.timestamp = Date.now();

        const reply = await loop.processMessage(agent, session, mockMsg);
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
    if (provider) {
      router.register(provider);
    }
  }

  console.log('\n🏥 Health Check\n');
  const results = await router.healthCheckAll();

  for (const [name, ok] of Object.entries(results)) {
    const status = ok ? '✅ OK' : '❌ FAIL';
    console.log(`  ${name}: ${status}`);
  }

  console.log();
}

// ================================================================
// 主入口
// ================================================================

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help || args.command === 'help') {
    showHelp();
    return;
  }

  switch (args.command) {
    case 'serve':
      await serveCommand(args);
      break;
    case 'chat':
      await chatCommand(args);
      break;
    case 'health':
      await healthCommand(args);
      break;
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
