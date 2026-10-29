/**
 * octopi chat CLI 选择面：--agent / --resume 解析与 agent 选择。
 */

import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import { selectChatAgent } from '../src/cli/helpers.js';

describe('parseArgs（chat flags）', () => {
  it('--agent / --resume 正常取值', () => {
    const args = parseArgs(['chat', '--agent', 'main', '--resume', 's-42']);
    expect(args.command).toBe('chat');
    expect(args.agent).toBe('main');
    expect(args.resume).toBe('s-42');
  });

  it('缺省不带 agent/resume', () => {
    const args = parseArgs(['chat']);
    expect(args.agent).toBeUndefined();
    expect(args.resume).toBeUndefined();
  });

  it('缺值时报错（不静默吞）', () => {
    expect(() => parseArgs(['chat', '--agent'])).toThrow(/--agent requires a value/);
    expect(() => parseArgs(['chat', '--resume', '--verbose'])).toThrow(/--resume requires a value/);
  });
});

describe('selectChatAgent', () => {
  const agents = [{ id: 'a1' }, { id: 'a2' }];

  it('缺省取第一个 agent', () => {
    expect(selectChatAgent(agents)?.id).toBe('a1');
  });

  it('按 id 精确命中', () => {
    expect(selectChatAgent(agents, 'a2')?.id).toBe('a2');
  });

  it('id 不存在或列表为空返回 undefined（调用方报错退出）', () => {
    expect(selectChatAgent(agents, 'nope')).toBeUndefined();
    expect(selectChatAgent([], 'a1')).toBeUndefined();
  });
});
