import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { LLMRequest, ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
import type { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';

let root: string;
let previousHome: string | undefined;
const requests: LLMRequest[] = [];
const gateways: Gateway[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'octopi-gateway-plugin-tool-'));
  requests.length = 0;
  previousHome = process.env.OCTOPI_HOME;
  process.env.OCTOPI_HOME = join(root, 'home');
  mkdirSync(join(root, 'plugins', 'acme'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'acme', 'octopi.plugin.json'), JSON.stringify({
    id: 'acme.search', apiVersion: '1', version: '1.0.0', name: 'Acme', entry: './index.mjs',
    engine: { octopi: '>=0.1.0' }, configSchema: { type: 'object' }, contributes: { tools: ['acme_echo'] },
  }));
  writeFileSync(join(root, 'plugins', 'acme', 'index.mjs'), `export default { id: 'acme.search', register(api) {
    api.registerTool({ name: 'acme_echo', description: 'Echo', parameters: {}, capabilities: ['egress'] }, async () => 'ok');
  } };`);
});

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.stop();
  if (previousHome === undefined) delete process.env.OCTOPI_HOME;
  else process.env.OCTOPI_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

const provider: ModelProvider = {
  name: 'mock', defaultModel: 'm',
  async chat(request: LLMRequest) {
    requests.push(request);
    return { content: 'ok', model: 'm', finishReason: 'stop' };
  },
  async *stream() { yield { type: 'done' as const }; },
  async isAvailable() { return true; },
  getModelInfo() { return { name: 'm', contextWindow: 32000 }; },
  getModelInfos() { return [{ name: 'm', contextWindow: 32000 }]; },
};

function agent(id: string, allow: string[]): AgentDefinition {
  return { id, model: { provider: 'mock', model: 'm' }, tools: { allow }, persona: { systemPrompt: 'test' } } as AgentDefinition;
}

async function makeGateway(agents: AgentDefinition[], enabled = true): Promise<Gateway> {
  const gateway = new Gateway({
    agents,
    knowledge: { service: { manageLocal: false } },
    plugins: { loadPaths: [join(root, 'plugins')], entries: { 'acme.search': { enabled } } },
  }, new InMemorySessionStore());
  gateways.push(gateway);
  await gateway.start();
  (gateway as unknown as { providers: Map<string, ModelProvider> }).providers.set('mock', provider);
  return gateway;
}

async function build(gateway: Gateway, definition: AgentDefinition) {
  return (gateway as unknown as {
    buildAgent(def: AgentDefinition): Promise<{
      agent: { context: { tools?: Array<{ name: string; source?: { origin?: string } }> } };
      runner: SessionAwareRunner;
    }>;
  }).buildAgent(definition);
}

describe('Gateway Plugin Tool integration', () => {
  it('projects a real manifest plugin per Agent using tools.allow and preserves source', async () => {
    const deniedDefinition = agent('denied', []);
    const allowedDefinition = agent('allowed', ['acme_echo']);
    const gateway = await makeGateway([deniedDefinition, allowedDefinition]);
    const denied = await build(gateway, deniedDefinition);
    const allowed = await build(gateway, allowedDefinition);
    expect(denied.agent.context.tools?.some((tool) => tool.name === 'acme_echo')).toBe(true);
    const tool = allowed.agent.context.tools?.find((candidate) => candidate.name === 'acme_echo');
    expect(tool?.source?.origin).toBe('acme.search');
    for await (const _ of denied.runner.handle('denied-session', { role: 'user', content: 'hello', timestamp: Date.now() } satisfies Message, {
      systemPrompt: '', agentId: 'denied', sessionId: 'denied-session',
    })) { /* drain the real Gateway run */ }
    expect(requests.at(-1)?.tools?.some((definition) => definition.function.name === 'acme_echo')).toBe(false);
    for await (const _ of allowed.runner.handle('allowed-session', { role: 'user', content: 'hello', timestamp: Date.now() } satisfies Message, {
      systemPrompt: '', agentId: 'allowed', sessionId: 'allowed-session',
    })) { /* drain the real Gateway run */ }
    expect(requests.at(-1)?.tools?.some((definition) => definition.function.name === 'acme_echo')).toBe(true);
  });

  it('does not mount a disabled plugin into any Agent', async () => {
    const definition = agent('allowed', ['*']);
    const gateway = await makeGateway([definition], false);
    const built = await build(gateway, definition);
    expect(built.agent.context.tools?.some((tool) => tool.name === 'acme_echo')).toBe(false);
  });
});
