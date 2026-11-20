/**
 * The running test, for matchers that need to know it (screenshot
 * baselines are named after the test and stored next to its file).
 * AsyncLocalStorage keeps it right when tests in a file run in
 * parallel.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type UpdateSnapshots = 'all' | 'missing' | 'none';

export interface TestInfo {
  title: string;
  file: string;
  /** Screenshots taken so far without an explicit name. */
  snapshotIndex: number;
  outputDir: string;
  updateSnapshots: UpdateSnapshots;
  /** Stop the running test and mark it skipped. */
  skip: (reason?: string) => never;
}

export const testInfoStore = new AsyncLocalStorage<TestInfo>();

export function currentTestInfo(): TestInfo | undefined {
  return testInfoStore.getStore();
}

/** TESTSURFER_UPDATE_SNAPSHOTS=1 (or `all`, `missing`, `none`) overrides the config. */
export function updateSnapshotsFromEnv(): UpdateSnapshots | undefined {
  const v = process.env['TESTSURFER_UPDATE_SNAPSHOTS'];
  if (!v) return undefined;
  if (v === '1' || v === 'true' || v === 'all') return 'all';
  if (v === 'missing' || v === 'none') return v;
  return undefined;
}
