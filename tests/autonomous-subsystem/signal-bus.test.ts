import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignalBus } from '../../src/harness/autonomous-subsystem/signal/bus.js';
import { DefaultEventBus } from '../../src/core/primitives/event-bus.js';

describe('SignalBus', () => {
  let events: DefaultEventBus;
  let bus: SignalBus;

  beforeEach(() => {
    events = new DefaultEventBus();
    bus = new SignalBus({ events });
  });

  describe('deliver', () => {
    it('delivers block signal to event channel', () => {
      const eventSpy = vi.fn();
      events.on('subsystem.signal.block', eventSpy);

      bus.deliver('test', {
        signals: [{ action: 'block', reason: 'dangerous command', confidence: 0.9 }],
      });

      expect(eventSpy).toHaveBeenCalledTimes(1);
      expect(eventSpy.mock.calls[0][0].data.action).toBe('block');
      expect(eventSpy.mock.calls[0][0].data.reason).toBe('dangerous command');
    });

    it('delivers suggest signal to context + event channels', () => {
      const eventSpy = vi.fn();
      events.on('subsystem.signal.suggest', eventSpy);

      bus.deliver('test', {
        signals: [{ action: 'suggest', reason: 'consider using TypeScript' }],
      });

      // event channel
      expect(eventSpy).toHaveBeenCalledTimes(1);

      // context channel
      expect(bus.pendingCounts.context).toBe(1);
    });

    it('delivers escalate signal to escalate + event channels', () => {
      const eventSpy = vi.fn();
      events.on('subsystem.signal.escalate', eventSpy);

      bus.deliver('test', {
        signals: [{ action: 'escalate', reason: 'need human intervention' }],
      });

      expect(eventSpy).toHaveBeenCalledTimes(1);
      expect(bus.pendingCounts.escalate).toBe(1);
    });

    it('delivers replace signal to context channel with compressed flag', () => {
      bus.deliver('test', {
        signals: [{ action: 'replace', reason: 'compressed context' }],
      });

      expect(bus.pendingCounts.context).toBe(1);
    });

    it('sorts signals by priority (block before suggest)', () => {
      const eventOrder: string[] = [];
      events.onAll((e) => {
        if (e.type.startsWith('subsystem.signal.')) {
          eventOrder.push(e.data!.action as string);
        }
      });

      bus.deliver('test', {
        signals: [
          { action: 'suggest', reason: 'info' },
          { action: 'block', reason: 'danger' },
        ],
      });

      // block (priority 0) should be emitted before suggest (priority 3)
      expect(eventOrder).toEqual(['block', 'suggest']);
    });

    it('delivers multiple signals from one output', () => {
      bus.deliver('test', {
        signals: [
          { action: 'alert', reason: 'warning' },
          { action: 'suggest', reason: 'info' },
        ],
      });

      // alert → context + event; suggest → context + event
      expect(bus.pendingCounts.context).toBe(2);
    });
  });

  describe('applyPendingContext', () => {
    it('applies pending context injections to messages array', () => {
      bus.deliver('test', {
        signals: [{ action: 'suggest', reason: 'use TypeScript' }],
      });

      const messages: any[] = [];
      bus.applyPendingContext(messages);

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('use TypeScript');
    });

    it('clears queue after applying', () => {
      bus.deliver('test', {
        signals: [{ action: 'suggest', reason: 'test' }],
      });

      const messages: any[] = [];
      bus.applyPendingContext(messages);
      expect(bus.pendingCounts.context).toBe(0);

      // Second call should not add more messages
      bus.applyPendingContext(messages);
      expect(messages).toHaveLength(1);
    });

    it('replace signal sets compressed flag', () => {
      bus.deliver('test', {
        signals: [{ action: 'replace', reason: 'compressed' }],
      });

      const messages: any[] = [];
      bus.applyPendingContext(messages);

      expect(messages[0].metadata.compressed).toBe(true);
    });
  });

  describe('consumeSteering / consumeEscalate', () => {
    it('consumeSteering returns and clears steering queue', () => {
      // escalate goes to escalate queue, not steering
      bus.deliver('test', {
        signals: [{ action: 'escalate', reason: 'urgent' }],
      });

      const steering = bus.consumeSteering();
      expect(steering).toHaveLength(0);

      const escalate = bus.consumeEscalate();
      expect(escalate).toHaveLength(1);
      expect(escalate[0].signal.action).toBe('escalate');
      expect(bus.pendingCounts.escalate).toBe(0);
    });
  });

  describe('clear', () => {
    it('clears all queues', () => {
      bus.deliver('test', {
        signals: [
          { action: 'suggest', reason: 'info' },
          { action: 'escalate', reason: 'urgent' },
          { action: 'replace', reason: 'compress' },
        ],
      });

      bus.clear();

      expect(bus.pendingCounts).toEqual({ context: 0, steering: 0, escalate: 0 });
    });
  });

  describe('no-op signal', () => {
    it('delivers no-op to event channel only', () => {
      const eventSpy = vi.fn();
      events.on('subsystem.signal.no-op', eventSpy);

      bus.deliver('test', {
        signals: [{ action: 'no-op', reason: 'nothing to do' }],
      });

      expect(eventSpy).toHaveBeenCalledTimes(1);
      expect(bus.pendingCounts.context).toBe(0);
      expect(bus.pendingCounts.escalate).toBe(0);
    });
  });
});
