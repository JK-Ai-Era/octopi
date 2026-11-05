import type { LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import {
  formatTurnContextXml,
  formatTurnStartContent,
  joinSlotXml,
  parseTurnEnvelope,
} from '../../../context/turn-envelope.js';
import { PluginRuntimeSnapshotLayer } from '../../../context/layers.js';

/**
 * Build a Run/Iteration-only view. The authoritative turn_start remains byte-frozen.
 * No system role is added and plugin content cannot masquerade as a user stimulus.
 */
export async function projectPluginIterationSnapshot(
  messages: LLMMessage[],
  contributions: readonly { pluginId: string; text: string }[],
  tokenBudget: number,
): Promise<LLMMessage[]> {
  if (contributions.length === 0) return messages;
  const layer = new PluginRuntimeSnapshotLayer(
    contributions.map(({ pluginId, text }) => ({ pluginId, value: { text } })),
  );
  const projected = await layer.assemble({
    sessionId: 'run',
    messages: [],
    tokenBudget: Math.max(1, tokenBudget),
    systemBudget: 0,
  });
  if (!projected) return messages;
  const index = messages.findLastIndex((message) => parseTurnEnvelope(message.content) !== null);
  if (index < 0) throw new Error('before_iteration snapshot requires a current turn_start envelope');
  const original = messages[index]!;
  const parsed = parseTurnEnvelope(original.content)!;
  if (!parsed.turnId || !parsed.at || !parsed.hasUserMessage) {
    throw new Error('before_iteration snapshot cannot rewrite an incomplete turn envelope');
  }
  const slots = parsed.slots.map((slot) => ({ tag: slot.tag, body: slot.body }));
  const runtime = slots.find((slot) => slot.tag === 'runtime_snapshot');
  if (runtime) runtime.body = [runtime.body, projected.text].filter(Boolean).join('\n\n');
  else slots.unshift({ tag: 'runtime_snapshot', body: projected.text });
  const content = formatTurnStartContent({
    turnId: parsed.turnId,
    at: parsed.at,
    turnContextXml: formatTurnContextXml({ turnId: parsed.turnId, slotsXml: joinSlotXml(slots) }),
    userText: parsed.userText,
  });
  const copy: LLMMessage = { ...original };
  if (typeof original.content === 'string' || original.content == null) copy.content = content;
  else if (Array.isArray(original.content)) {
    copy.content = [
      { type: 'text', text: content },
      ...original.content.filter((block) => block.type !== 'text'),
    ];
  }
  return [...messages.slice(0, index), copy, ...messages.slice(index + 1)];
}

/** Apply the configured token budget before the snapshot reaches a model request. */
export function iterationSnapshotTokenBudget(configured: number | undefined, contextWindow: number | undefined): number {
  const cap = Math.max(1, Math.floor((contextWindow ?? 8192) * 0.1));
  return Math.max(1, Math.min(configured ?? 4096, cap));
}
