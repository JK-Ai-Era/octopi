/**
 * Agent 通信协议测试
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { DefaultEventBus } from '../src/core/event-bus.js';
import {
  DefaultAgentCommunicator,
  createAgentMessage,
} from '../src/core/agent-communicator.js';
import type { AgentMessage } from '../src/core/interfaces/agent-message.js';

describe('Agent 通信协议', () => {
  let events: DefaultEventBus;
  let communicator: DefaultAgentCommunicator;

  beforeEach(() => {
    events = new DefaultEventBus();
    communicator = new DefaultAgentCommunicator(events);
  });

  describe('createAgentMessage', () => {
    test('创建消息有默认值', () => {
      const msg = createAgentMessage('request', 'agent-a', 'agent-b', '请完成任务');
      
      expect(msg.id).toBeDefined();
      expect(msg.type).toBe('request');
      expect(msg.from).toBe('agent-a');
      expect(msg.to).toBe('agent-b');
      expect(msg.content).toBe('请完成任务');
      expect(msg.timestamp).toBeGreaterThan(0);
      expect(msg.metadata.priority).toBe('normal');
    });

    test('支持自定义选项', () => {
      const msg = createAgentMessage('delegate', 'orchestrator', 'worker', '处理数据', {
        conversationId: 'conv-123',
        metadata: { priority: 'high', tags: ['data'] },
      });
      
      expect(msg.conversationId).toBe('conv-123');
      expect(msg.metadata.priority).toBe('high');
      expect(msg.metadata.tags).toEqual(['data']);
    });
  });

  describe('send', () => {
    test('发送消息触发事件', async () => {
      const handler = vi.fn();
      events.on('agent.message', handler);
      
      const msg = createAgentMessage('request', 'a', 'b', 'test');
      await communicator.send(msg);
      
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].data.content).toBe('test');
    });
  });

  describe('onMessage', () => {
    test('注册处理器接收定向消息', async () => {
      const handler = vi.fn();
      communicator.onMessage('agent-b', handler);
      
      const msg = createAgentMessage('request', 'agent-a', 'agent-b', 'hello');
      await communicator.send(msg);
      
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].content).toBe('hello');
    });

    test('不接收非定向消息', async () => {
      const handler = vi.fn();
      communicator.onMessage('agent-c', handler);
      
      const msg = createAgentMessage('request', 'agent-a', 'agent-b', 'hello');
      await communicator.send(msg);
      
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('broadcast', () => {
    test('广播消息发送给所有处理器', async () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();
      communicator.onMessage('agent-a', handlerA);
      communicator.onMessage('agent-b', handlerB);
      
      await communicator.broadcast(
        createAgentMessage('broadcast', 'system', '*', '系统通知')
      );
      
      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerB).toHaveBeenCalledTimes(1);
    });
  });

  describe('request', () => {
    test('请求-响应模式', async () => {
      // 注册响应处理器
      communicator.onMessage('agent-b', (msg) => {
        if (msg.type === 'request') {
          communicator.send(
            createAgentMessage('response', 'agent-b', 'agent-a', '收到', {
              replyTo: msg.id,
            })
          );
        }
      });
      
      const request = createAgentMessage('request', 'agent-a', 'agent-b', '你好吗？');
      const response = await communicator.request(request, 2000);
      
      expect(response.content).toBe('收到');
      expect(response.replyTo).toBe(request.id);
    });

    test('请求超时抛出错误', async () => {
      const request = createAgentMessage('request', 'agent-a', 'agent-b', '你好吗？');
      
      await expect(
        communicator.request(request, 100)
      ).rejects.toThrow('Request timeout');
    });
  });

  describe('receive', () => {
    test('接收队列正确存储消息', async () => {
      // 先创建接收迭代器（这样队列才会存在）
      const iter = communicator.receive('agent-b');
      
      // 先调用 next() 让生成器开始等待
      const pending1 = iter.next();
      
      // 发送消息
      await communicator.send(createAgentMessage('request', 'a', 'agent-b', 'msg1'));
      
      // 第一条消息
      const result1 = await pending1;
      expect(result1.value.content).toBe('msg1');
      
      // 发送第二条消息
      await communicator.send(createAgentMessage('request', 'a', 'agent-b', 'msg2'));
      
      // 第二条消息
      const result2 = await iter.next();
      expect(result2.value.content).toBe('msg2');
    }, 5000);

    test('先启动接收器再发送消息', async () => {
      const received: AgentMessage[] = [];
      
      // 启动接收器（后台运行）
      const iter = communicator.receive('agent-c');
      
      // 先调用 next() 让生成器开始等待
      const pending = iter.next();
      
      // 发送消息
      await communicator.send(createAgentMessage('request', 'a', 'agent-c', 'hello'));
      
      // 等待接收
      const result = await pending;
      received.push(result.value);
      
      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('hello');
    }, 5000);
  });
});
