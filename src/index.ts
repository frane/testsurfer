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
export { APIRequestContext, type RequestOptions } from './request.ts';
export { Frame } from './frame.ts';

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
