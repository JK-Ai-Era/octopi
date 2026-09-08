/**
 * Autonomous Subsystem — Shared Errors
 *
 * @module autonomous-subsystem/errors
 */

export class SubsystemTimeoutError extends Error {
  constructor(message = 'Subsystem execution timed out') {
    super(message);
    this.name = 'SubsystemTimeoutError';
  }
}
