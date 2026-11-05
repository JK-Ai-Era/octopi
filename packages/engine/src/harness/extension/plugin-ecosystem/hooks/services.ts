import type { PluginServiceRecord } from '../plugins/contribution-registry.js';
import type { HookAuditRecord } from './types.js';

export interface PluginServiceAudit {
  append(record: HookAuditRecord): Promise<void>;
}

/** Host-owned service lifecycle. Registration alone has no background side effect. */
export class PluginServiceSupervisor {
  private started = new Set<string>();
  private starting = false;
  private stopping = false;

  constructor(
    private readonly onFailure: (service: PluginServiceRecord, error: unknown) => void,
    private readonly audit?: PluginServiceAudit,
  ) {}

  /** Start in registration order; required failures roll back previously started services. */
  async start(services: readonly PluginServiceRecord[]): Promise<void> {
    if (this.starting) throw new Error('Plugin service startup is already in progress');
    if (this.stopping) throw new Error('Plugin service startup cannot overlap shutdown');
    if (this.started.size > 0) return;
    this.starting = true;
    try {
      for (const service of services) {
        if (!service.start) continue;
        try {
          await this.invoke(service, 'start');
          this.started.add(this.key(service));
          await this.record(service, 'start', 'ok');
        } catch (error) {
          await this.record(service, 'start', 'error', error);
          // A failed or timed-out start may already hold ports/timers: release the
          // failing service itself first, or its partial resources leak past rollback.
          await this.stopOne(service);
          if (service.required) {
            await this.stop(services);
            throw new Error(`Required plugin service ${service.pluginId}/${service.serviceId} failed to start: ${this.message(error)}`);
          }
          this.onFailure(service, error);
        }
      }
    } finally {
      this.starting = false;
    }
  }

  /** Stop only actually-started services, in reverse order; report all failures. */
  async stop(services: readonly PluginServiceRecord[]): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    try {
      const started = services.filter((service) => this.started.has(this.key(service))).reverse();
      for (const service of started) {
        this.started.delete(this.key(service));
        try {
          await this.invoke(service, 'stop');
          await this.record(service, 'stop', 'ok');
        } catch (error) {
          await this.record(service, 'stop', 'error', error);
          this.onFailure(service, error);
        }
      }
    } finally {
      this.stopping = false;
    }
  }

  /** Best-effort cleanup for a service that failed mid-start; never masks the start failure. */
  private async stopOne(service: PluginServiceRecord): Promise<void> {
    if (!service.stop) return;
    try {
      await this.invoke(service, 'stop');
      await this.record(service, 'stop', 'ok');
    } catch (error) {
      // Swallowed on purpose: the start failure is the reported cause; cleanup
      // errors only add audit context and must not replace it.
      await this.record(service, 'stop', 'error', error);
    }
  }

  private key(service: PluginServiceRecord): string {
    return `${service.pluginId}:${service.serviceId}`;
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async record(
    service: PluginServiceRecord,
    phase: 'start' | 'stop',
    outcome: 'ok' | 'error',
    error?: unknown,
  ): Promise<void> {
    if (!this.audit) return;
    const hookName = phase === 'start' ? 'service_start' : 'service_stop';
    try {
      await this.audit.append({
        pluginId: service.pluginId,
        hookName,
        phase: 'observe',
        outcome,
        sessionId: 'system',
        agentId: 'host',
        ...(error === undefined ? {} : { reason: this.message(error) }),
        details: { serviceId: service.serviceId, phase },
      });
    } catch (auditError) {
      this.onFailure(service, new Error(`Service lifecycle audit failed (${phase}/${outcome}): ${this.message(auditError)}`));
    }
  }

  private async invoke(service: PluginServiceRecord, phase: 'start' | 'stop'): Promise<void> {
    const timeoutMs = service.timeoutMs ?? 30_000;
    const controller = new AbortController();
    let settled = false;
    const timer = setTimeout(() => {
      controller.abort(new Error(`Plugin service ${phase} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          if (error !== undefined) reject(error);
          else resolve();
        };
        controller.signal.addEventListener('abort', () => finish(controller.signal.reason), { once: true });
        Promise.resolve()
          .then(() => phase === 'start' ? service.start?.(controller.signal) : service.stop?.(controller.signal))
          .then(() => finish(), finish);
      });
    } finally {
      settled = true;
      clearTimeout(timer);
    }
  }
}
