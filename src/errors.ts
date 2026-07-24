/** Errors thrown by testsurfer. */

/**
 * A `! CODE args...` error envelope from the vibesurfer daemon.
 * `code` is the wire error code (STALE_TOKEN, NOT_FOUND, BAD_REQUEST, ...);
 * `args` are the space-separated arguments that followed it.
 */
export class WireError extends Error {
  readonly code: string;
  readonly args: string[];

  constructor(code: string, args: string[]) {
    super(`vibesurfer error: ${code}${args.length ? ' ' + args.join(' ') : ''}`);
    this.name = 'WireError';
    this.code = code;
    this.args = args;
  }
}

/** An action or assertion did not complete within its timeout. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * A locator matched more than one element. Mirrors Playwright's strict
 * mode: an action needs exactly one target. Narrow the locator or pick
 * one with `.first()` / `.nth(i)`.
 */
export class StrictModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictModeError';
  }
}
