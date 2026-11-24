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

export { Browser, BrowserContext, type LaunchOptions } from './browser.ts';
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
export {
  APIResponse,
  ConsoleMessage,
  Dialog,
  Request,
  Response,
  Route,
  type ContinueOptions,
  type FulfillOptions,
  type RouteHandler,
  type UrlMatcher,
} from './events.ts';
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
 * Playwright's device descriptors, reduced to what testsurfer applies
 * (the viewport). Lets a playwright.config that spreads devices[...]
 * load.
 */
export const devices: Record<string, { viewport: { width: number; height: number }; deviceScaleFactor: number; defaultBrowserType: string }> = {
  'Desktop Chrome': { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, defaultBrowserType: 'chromium' },
  'Desktop Edge': { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, defaultBrowserType: 'chromium' },
  'Desktop Firefox': { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, defaultBrowserType: 'firefox' },
  'Desktop Safari': { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, defaultBrowserType: 'webkit' },
  'iPhone 13': { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, defaultBrowserType: 'webkit' },
  'Pixel 5': { viewport: { width: 393, height: 727 }, deviceScaleFactor: 2.75, defaultBrowserType: 'chromium' },
};
export { selectors } from './selectors.ts';

// Record API calls for context.tracing (see src/tracing.ts).
import { instrument, Tracing } from './tracing.ts';
import { BrowserContext as TracedCtx } from './browser.ts';
import { Page as TracedPage } from './page.ts';
import { Locator as TracedLocator } from './locator.ts';
import { Frame as TracedFrame } from './frame.ts';
import { LocatorAssertions, PageAssertions } from './expect.ts';
type AnyRec = Record<string, unknown>;
const ctxOfPage = (p: unknown): { tracing: Tracing | null; pageId?: string } => {
  try {
    const page = p as TracedPage;
    const id = page.wireId();
    return { tracing: (page.context() as unknown as { tracing: Tracing }).tracing, ...(id ? { pageId: `page@${id}` } : {}) };
  } catch {
    return { tracing: null };
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
