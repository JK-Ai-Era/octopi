const terminalMarker = Symbol('octopi.extension-terminal');

/** A Host-controlled extension failure must not enter the model transport retry policy. */
export class ExtensionTerminalError extends Error {
  readonly [terminalMarker] = true;

  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ExtensionTerminalError';
  }
}

/** This is a Host/reliability policy, not a Core or Plugin contract. */
export function shouldAbortWithoutRetry(error: unknown): boolean {
  return typeof error === 'object' && error !== null && terminalMarker in error;
}

/** Restore the extension failure to the normal Agent error-event surface. */
export function unwrapExtensionTerminalError(error: unknown): unknown {
  return error instanceof ExtensionTerminalError ? error.cause : error;
}
