/**
 * testsurfer: end-to-end testing for the web, driven by vibesurfer.
 *
 *     import { test, expect } from 'testsurfer';
 *
 *     test('login', async ({ page }) => {
 *       await page.goto('https://example.com/login');
 *       await page.getByRole('textbox', { name: 'Email' }).fill('a@b.com');
 *       await page.getByRole('button', { name: 'Sign in' }).click();
 *       await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
 *     });
 */

import { readFileSync } from 'node:fs';

export { Browser, BrowserContext, browserType, type LaunchOptions } from './browser.ts';
import { browserType as makeType } from './browser.ts';
/** Playwright's browser types; all of them run on the OS web view. */
export const webkit = makeType('webkit');
export const chromium = makeType('chromium');
export const firefox = makeType('firefox');
export { Page, type ClickVia, type InputMode, type LayoutRect, type ProtocolOptions, type Timeouts } from './page.ts';
export { ElementHandle, FrameLocator, JSHandle, Locator, type ByRoleOptions, type ByTextOptions, type FilterOptions, type LocatorOptions } from './locator.ts';
export { expect, LocatorAssertions, PageAssertions, type ExpectOptions } from './expect.ts';
export { ValueAssertions, AssertionError } from './values.ts';
export {
  test,
  configure,
  defineConfig,
  type DescribeFn,
  type FixtureDefFor,
  type RunnerOptions,
  type TestApi,
  type TestFixtures,
  type WorkerFixtures,
} from './runner.ts';
export { WireError, TimeoutError, StrictModeError } from './errors.ts';
export { PINNED_VIBESURFER } from './client.ts';
export { ConsoleMessage } from './console.ts';
export { Dialog } from './dialog.ts';
export { APIResponse, Request, Response } from './http.ts';
export { Route, type ContinueOptions, type FulfillOptions, type RouteHandler } from './route.ts';
export type { UrlMatcher } from './url.ts';
export type { TestInfo } from './testinfo.ts';
export { APIRequestContext, request, type RequestOptions } from './request.ts';
export { Frame } from './frame.ts';
export { Download } from './download.ts';
export { WebSocket, WebSocketRoute } from './websocket.ts';
export { Clock } from './clock.ts';
export { Worker } from './worker.ts';
export { Video } from './video.ts';
export { FileChooser } from './filechooser.ts';
export type { Cookie, StorageState } from './cookies.ts';
export type { ContextOptions } from './browser.ts';

/**
 * Playwright's device descriptors (user agent, viewport, scale,
 * isMobile, hasTouch), from Playwright's deviceDescriptorsSource.json
 * (Apache-2.0, Microsoft). Spread one into `use` or newContext().
 */
export const devices: Record<
  string,
  { userAgent: string; viewport: { width: number; height: number }; screen?: { width: number; height: number }; deviceScaleFactor: number; isMobile: boolean; hasTouch: boolean; defaultBrowserType: string }
> = JSON.parse(readFileSync(new URL('./devices.json', import.meta.url), 'utf8'));
export { selectors } from './selectors.ts';

// Record API calls for context.tracing (see src/tracing.ts).
import { instrument, Tracing } from './tracing.ts';
import { BrowserContext as TracedCtx } from './browser.ts';
import { Page as TracedPage } from './page.ts';
import { Locator as TracedLocator } from './locator.ts';
import { Frame as TracedFrame } from './frame.ts';
import { LocatorAssertions, PageAssertions } from './expect.ts';
type AnyRec = Record<string, unknown>;
const ctxOfPage = (p: unknown): { tracing: Tracing | null; pageId?: string; page?: unknown } => {
  try {
    const page = p as TracedPage;
    const id = page.wireId();
    return { page, tracing: (page.context() as unknown as { tracing: Tracing }).tracing, ...(id ? { pageId: `page@${id}` } : {}) };
  } catch {
    return { tracing: null, page: p };
  }
};
const internal = ['runLocatorHandlers', 'engineCall', 'engineRun', 'adoptResult', 'openedId', 'clickAt', 'loadCookieBlob', 'refreshNetwork', 'wsCall', 'recordVideo', 'adoptBlank', 'storeCookies', 'applyStorageState', 'configure'];
instrument(TracedPage.prototype, 'Page', ctxOfPage, internal);
instrument(TracedLocator.prototype, 'Locator', (l) => ctxOfPage((l as AnyRec)['owner'] ?? (l as AnyRec)['ownerPage']), internal);
instrument(TracedFrame.prototype, 'Frame', (f) => ctxOfPage((f as AnyRec)['owner']));
instrument(TracedCtx.prototype, 'BrowserContext', (c) => ({ tracing: (c as { tracing: Tracing }).tracing }), internal);
instrument(LocatorAssertions.prototype, 'Expect', (a) => {
  const loc = (a as AnyRec)['locator'] as { toString(): string } | undefined;
  return { ...ctxOfPage((loc as AnyRec | undefined)?.['owner']), ...(loc ? { selector: loc.toString() } : {}) };
});
instrument(PageAssertions.prototype, 'Expect', (a) => ctxOfPage((a as AnyRec)['page']));
export { Tracing };
