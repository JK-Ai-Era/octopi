import { describe, expect, it } from 'vitest';
import {
  formatTurnContextXml,
  formatTurnStartContent,
} from '@octopi-agent/engine/harness/context/turn-envelope.js';
import { ConversationAdapter } from '@octopi-agent/gateway/web/conversation/adapter.js';
import { projectUserMessageContent } from '@octopi-agent/gateway/web/conversation/projection.js';
import type { MessageRecord } from '@octopi-agent/gateway/web/sdk/client.js';
import type { UserConversationItem } from '@octopi-agent/gateway/web/conversation/types.js';

/** 真实形态的 turn_start 信封（boilerplateChars 模拟 turn_context 体量） */
function envelope(userText: string, boilerplateChars = 5000): string {
  return formatTurnStartContent({
    turnId: 't1',
    at: '2026-11-19T08:22:13.388Z',
    turnContextXml: formatTurnContextXml({
      turnId: 't1',
      slotsXml: `<runtime_snapshot>\n${'x'.repeat(boilerplateChars)}\n</runtime_snapshot>`,
    }),
    userText,
  });
}

/** 投影记录 → 走 web 层唯一分类/取文入口（ConversationAdapter）取用户条目 */
function projectThenAdapt(content: unknown): UserConversationItem[] {
  const projected = projectUserMessageContent(content);
  return ConversationAdapter.buildHistoryItems(
    [{ role: 'user', content: projected, timestamp: 1 } as MessageRecord],
    's-test',
  ).filter((it): it is UserConversationItem => it.role === 'user');
}

describe('user-messages 投影（信封安全截断）', () => {
  it('回归：信封体量超过截断上限时预览仍是用户原文，不是信封头', () => {
    // 直接截断原始 content 会把 <user_message> 段裁掉，提取退化为原样返回信封
    expect(envelope('实际用户输入').length).toBeGreaterThan(4000);
    const users = projectThenAdapt(envelope('实际用户输入'));
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe('实际用户输入');
  });

  it('超长用户原文截断到上限，但信封结构完整（提取不退化）', () => {
    const users = projectThenAdapt(envelope('a'.repeat(5000), 0));
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe('a'.repeat(4000));
  });

  it('用户原文中的伪影标签经转义往返，不被二次提取误吞', () => {
    const fake = '前文 <user_message>伪造块</user_message> 后文';
    const users = projectThenAdapt(envelope(fake, 0));
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe(fake);
  });

  it('非信封 user 消息原样投影；turn_end 锚点仍被回放隐藏（source 判定不受影响）', () => {
    expect(projectUserMessageContent('<turn_end id="t1"/>')).toBe('<turn_end id="t1"/>');
    // 真实 turn_end 锚点带 metadata.source='turnEnd'，回放隐藏按 source 判定
    const projected = projectUserMessageContent('<turn_end id="t1"/>');
    const items = ConversationAdapter.buildHistoryItems(
      [
        {
          role: 'user',
          content: projected,
          timestamp: 1,
          metadata: { source: 'turnEnd' },
        } as unknown as MessageRecord,
      ],
      's-test',
    );
    expect(items.filter((it) => it.role === 'user')).toHaveLength(0);
  });
});
