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
  /** Describe titles, then the test title. */
  titlePath: string[];
  file: string;
  /** Screenshots taken so far without an explicit name. */
  snapshotIndex: number;
  outputDir: string;
  updateSnapshots: UpdateSnapshots;
  annotations: { type: string; description?: string | undefined }[];
  attachments: { name: string; contentType: string; path?: string | undefined; body?: Buffer | undefined }[];
  /** Always 0: testsurfer does not retry. */
  retry: number;
  workerIndex: number;
  parallelIndex: number;
  project: { name: string; use: Record<string, unknown> };
  /** Milliseconds; informational, node:test owns the actual timeout. */
  timeout: number;
  /** Where toMatchSnapshot keeps baselines (see snapshotPath in screenshot.ts). */
  snapshotPathTemplate?: string | undefined;
  /** expect.soft() failures, thrown together when the test body ends. */
  softErrors: unknown[];
  /** Set by fail(): the test is expected to throw. */
  expectedStatus: 'passed' | 'failed' | 'skipped';
  /** Stop the running test and mark it skipped. */
  skip: (condition?: boolean | string, reason?: string) => void;
  fixme: (condition?: boolean | string, reason?: string) => void;
  /** Mark the test as expected to fail; it passes only if its body throws. */
  fail: (condition?: boolean | string, reason?: string) => void;
  slow: (condition?: boolean | string, reason?: string) => void;
  setTimeout: (ms: number) => void;
  /** A path under this test's output directory. */
  outputPath: (...parts: string[]) => string;
  attach: (name: string, o?: { body?: string | Buffer; path?: string; contentType?: string }) => Promise<void>;
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
