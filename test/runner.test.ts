/**
 * The runner surface beyond plain tests: test.extend fixtures,
 * parallel describe blocks, conditional skips, steps, beforeAll,
 * and several pages and contexts in one test.
 */

import { after, before } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { configure, expect, test, type Page } from '../src/index.ts';

let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${req.url === '/two' ? 'Two' : 'One'}</title><h1>${req.url}</h1>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  configure({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
});

after(() => server.close());

class Home {
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
  async open(): Promise<void> {
    await this.page.goto('/one');
  }
}

const log: string[] = [];
const it = test.extend<{ home: Home; greeting: string }>({
  greeting: 'hello',
  home: async ({ page }, use) => {
    log.push('home setup');
    await use(new Home(page));
    log.push('home teardown');
  },
});

it('extended fixtures are built from page and torn down after', async ({ home, greeting }) => {
  assert.equal(greeting, 'hello');
  await home.open();
  await expect(home.page).toHaveTitle('One');
  assert.deepEqual(log, ['home setup']);
});

test('the fixture from the last test was torn down', () => {
  assert.deepEqual(log, ['home setup', 'home teardown']);
});

let browserSeen = false;
test.describe('hooks and skips', () => {
  test.beforeAll(({ browser }) => {
    browserSeen = browser !== undefined;
  });

  test('beforeAll got the browser', () => {
    assert.ok(browserSeen);
  });

  test('conditional skip stops the test', () => {
    test.skip(true, 'not on this platform');
    throw new Error('should not run');
  });

  test('a step names itself in errors', async () => {
    const value = await test.step('compute', () => 42);
    assert.equal(value, 42);
    await assert.rejects(
      test.step('broken', () => {
        throw new Error('nope');
      }),
      /step "broken": nope/,
    );
  });
});

const started: number[] = [];
test.describe('parallel group', () => {
  test.describe.configure({ mode: 'parallel' });
  for (const n of [1, 2, 3]) {
    test(`waits ${n}`, async ({ page }) => {
      started.push(Date.now());
      await page.goto('/one');
      await page.waitForTimeout(800);
    });
  }
});

test('the parallel group started together', () => {
  assert.equal(started.length, 3);
  const spread = Math.max(...started) - Math.min(...started);
  assert.ok(spread < 700, `tests started ${spread}ms apart; they ran one after another`);
});

test('several pages and contexts', async ({ page, context, browser }) => {
  await page.goto('/one');
  const second = await context.newPage();
  await second.goto('/two');
  assert.equal(context.pages().length, 2);
  assert.equal(second.context(), context);
  await expect(page).toHaveTitle('One');
  await expect(second).toHaveTitle('Two');

  const other = await browser.newContext();
  const third = await other.newPage();
  await third.goto('/two');
  await expect(third.getByRole('heading')).toHaveText('/two');
  await other.close();
});

test('setContent loads HTML whose scripts run; content() returns it', async ({ page }) => {
  await page.setContent('<h1>Inline</h1><button onclick="this.textContent=\'pressed\'">Press</button>');
  await expect(page.getByRole('heading')).toHaveText('Inline');
  await page.getByRole('button').click();
  await expect(page.getByRole('button')).toHaveText('pressed');
  assert.match(await page.content(), /<h1>Inline<\/h1>/);
  assert.doesNotMatch(await page.content(), /data-vs-ref/);
});
