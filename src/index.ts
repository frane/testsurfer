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

export { Browser, type LaunchOptions } from './browser.ts';
export { Page, type ClickVia, type InputMode, type Timeouts } from './page.ts';
export { Locator, type ByRoleOptions, type ByTextOptions } from './locator.ts';
export { expect, LocatorAssertions, PageAssertions, type ExpectOptions } from './expect.ts';
export { test, configure, type TestFixtures } from './runner.ts';
export { WireError, TimeoutError, StrictModeError } from './errors.ts';
export { PINNED_VIBESURFER } from './client.ts';
