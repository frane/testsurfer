/** Waiting helpers shared by actions, assertions and polls. */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry cadence, as Playwright's: fast at first, then backing off. */
const BACKOFF = [0, 20, 50, 100, 100, 250] as const;

/** Wait before retry number `attempt` (0-based). */
export const backoff = (attempt: number) => sleep(BACKOFF[Math.min(attempt, BACKOFF.length - 1)]!);
