/**
 * playwright.config.* support, so a Playwright suite runs unedited:
 * the options testsurfer has an equivalent for are read from `use`
 * (merged with a WebKit project's `use` when the config has one),
 * `expect`, `timeout` and the snapshot settings. `webServer`,
 * `globalSetup` and `globalTeardown` run in src/global.ts, around the
 * whole run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PLAYWRIGHT_CONFIGS = ['playwright.config.ts', 'playwright.config.mts', 'playwright.config.js', 'playwright.config.mjs'];

/** The subset of Playwright's config testsurfer reads. */
export interface PlaywrightConfig {
  testDir?: string;
  timeout?: number;
  workers?: number | string;
  fullyParallel?: boolean;
  outputDir?: string;
  snapshotDir?: string;
  snapshotPathTemplate?: string;
  expect?: { timeout?: number; toHaveScreenshot?: { pathTemplate?: string } };
  use?: PlaywrightUse;
  projects?: { name?: string; use?: PlaywrightUse & { defaultBrowserType?: string; browserName?: string } }[];
  webServer?: WebServer | WebServer[];
  globalSetup?: string | string[];
  globalTeardown?: string | string[];
}

export interface PlaywrightUse {
  baseURL?: string;
  testIdAttribute?: string;
  viewport?: { width: number; height: number } | null;
  deviceScaleFactor?: number;
  actionTimeout?: number;
  navigationTimeout?: number;
  defaultBrowserType?: string;
  browserName?: string;
  storageState?: string | { cookies: unknown[]; origins: unknown[] };
}

export interface WebServer {
  command: string;
  url?: string;
  port?: number;
  cwd?: string;
  env?: Record<string, string>;
  reuseExistingServer?: boolean;
  timeout?: number;
}

/** The first playwright.config.* in `dir`, or null. */
export function findPlaywrightConfig(dir = process.cwd()): string | null {
  for (const name of PLAYWRIGHT_CONFIGS) {
    const file = path.resolve(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** Import a config (its `@playwright/test` imports resolve to testsurfer). */
export async function importPlaywrightConfig(file: string): Promise<PlaywrightConfig> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: PlaywrightConfig | Promise<PlaywrightConfig> };
  return (await mod.default) ?? {};
}

/** `use` for the run: the top level, then a WebKit project's on top (else the first project's). */
export function effectiveUse(cfg: PlaywrightConfig): PlaywrightUse {
  const projects = cfg.projects ?? [];
  const webkit = projects.find((p) => p.use?.defaultBrowserType === 'webkit' || p.use?.browserName === 'webkit' || /webkit|safari/i.test(p.name ?? ''));
  return { ...cfg.use, ...(webkit ?? projects[0])?.use };
}

/** The testsurfer options a Playwright config amounts to. */
export function runnerOptionsFrom(cfg: PlaywrightConfig, configDir: string): Record<string, unknown> {
  const use = effectiveUse(cfg);
  const out: Record<string, unknown> = {};
  if (use.baseURL) out['baseURL'] = use.baseURL;
  if (use.testIdAttribute) out['testIdAttribute'] = use.testIdAttribute;
  if (use.viewport) out['viewport'] = use.viewport;
  if (use.deviceScaleFactor) out['deviceScaleFactor'] = use.deviceScaleFactor;
  if (use.storageState) out['storageState'] = typeof use.storageState === 'string' ? path.resolve(configDir, use.storageState) : use.storageState;
  const ctx: Record<string, unknown> = {};
  for (const k of ['colorScheme', 'reducedMotion', 'forcedColors', 'contrast', 'extraHTTPHeaders', 'userAgent', 'locale', 'timezoneId', 'geolocation', 'permissions', 'offline', 'httpCredentials', 'javaScriptEnabled', 'hasTouch', 'isMobile', 'bypassCSP', 'serviceWorkers', 'ignoreHTTPSErrors', 'acceptDownloads'] as const) {
    const v = (use as Record<string, unknown>)[k];
    if (v !== undefined) ctx[k] = v;
  }
  if (Object.keys(ctx).length) out['contextOptions'] = ctx;
  if (cfg.timeout !== undefined) out['testTimeout'] = cfg.timeout;
  const timeouts: Record<string, number> = {};
  // 0 means "no limit" in Playwright; the test's own timeout then bounds it.
  const limit = (v: number | undefined) => (v === 0 ? (cfg.timeout ?? 30_000) : v);
  const action = limit(use.actionTimeout);
  const nav = limit(use.navigationTimeout);
  if (action !== undefined) timeouts['action'] = action;
  if (nav !== undefined) timeouts['navigation'] = nav;
  if (cfg.expect?.timeout !== undefined) timeouts['expect'] = cfg.expect.timeout;
  if (Object.keys(timeouts).length) out['timeouts'] = timeouts;
  if (cfg.outputDir) out['outputDir'] = path.resolve(configDir, cfg.outputDir);
  const template = cfg.expect?.toHaveScreenshot?.pathTemplate ?? cfg.snapshotPathTemplate;
  if (template) out['snapshotPathTemplate'] = template.replaceAll('{snapshotDir}', cfg.snapshotDir ?? '{testDir}');
  else if (cfg.snapshotDir) {
    process.env['TESTSURFER_TEST_DIR'] = path.resolve(configDir, cfg.testDir ?? '.');
    out['snapshotPathTemplate'] = `${path.resolve(configDir, cfg.snapshotDir)}/{relTestFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}`;
  }
  return out;
}
