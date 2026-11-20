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
export { FrameLocator, Locator, type ByRoleOptions, type ByTextOptions, type FilterOptions, type LocatorOptions } from './locator.ts';
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
