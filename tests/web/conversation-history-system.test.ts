/**
 * 历史消息 → Conversation：不应回放托管 system prompt
 */

import { describe, it, expect } from 'vitest';
import { ConversationAdapter } from '../../src/integration/web/conversation/adapter.js';

describe('buildHistoryItems hides managed systemPrompt', () => {
  it('跳过 metadata.source=systemPrompt', () => {
    const items = ConversationAdapter.buildHistoryItems(
      [
        {
          role: 'system',
          content: '# AGENTS.md\n\n长人格全文……',
          timestamp: 1,
          metadata: { source: 'systemPrompt' },
        },
        { role: 'user', content: 'hello', timestamp: 2 },
        { role: 'assistant', content: 'hi', timestamp: 3 },
      ],
      's1',
    );
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.role !== 'system')).toBe(true);
  });

  it('跳过无 metadata 但特征明显的长 system 人格', () => {
    const persona = `# AGENTS.md - Operating Instructions\n${'x'.repeat(300)}`;
    const items = ConversationAdapter.buildHistoryItems(
      [
        { role: 'system', content: persona, timestamp: 1 },
        { role: 'user', content: 'ok', timestamp: 2 },
      ],
      's1',
    );
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe('user');
  });

  it('保留普通短 system 通知', () => {
    const items = ConversationAdapter.buildHistoryItems(
      [{ role: 'system', content: '连接已恢复', timestamp: 1 }],
      's1',
    );
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe('system');
  });
});
