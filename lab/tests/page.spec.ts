import { test, expect } from '@playwright/test';

test.describe('keyboard', () => {
  // Fields only: on macOS, WebKit's Tab skips buttons and links (Safari's default).
  test('Tab and Shift+Tab move focus between fields', async ({ page }) => {
    await page.goto('/keyboard/tab-order.html');
    await page.getByLabel('First').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Second')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByLabel('First')).toBeFocused();
  });

  test('shortcuts with modifiers, Escape', async ({ page }) => {
    await page.goto('/keyboard/shortcut.html');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('#o')).toHaveText('palette');
    await page.keyboard.press('Escape');
    await expect(page.locator('#o')).toHaveText('closed');
  });

  test('Backspace and select-all editing', async ({ page }) => {
    await page.goto('/keyboard/editing.html');
    const box = page.getByLabel('Text');
    await box.fill('abcdef');
    await box.press('Backspace');
    await expect(box).toHaveValue('abcde');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('new');
    await expect(box).toHaveValue('new');
  });

  test('arrow keys in a listbox', async ({ page }) => {
    await page.goto('/keyboard/arrows.html');
    await page.getByRole('listbox').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { name: 'Three' })).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('page', () => {
  test('evaluate with arguments of many types', async ({ page }) => {
    await page.goto('/page/nav-b.html');
    const r = await page.evaluate(
      ({ d, n, re, nested }) => ({ year: d.getUTCFullYear(), big: n + 1n, flags: re.flags, deep: nested.a[1].b, back: new Date(0) }),
      { d: new Date(Date.UTC(2024, 0, 1)), n: 41n, re: /x/gi, nested: { a: [0, { b: 'ok' }] } },
    );
    expect(r).toEqual({ year: 2024, big: 42n, flags: 'gi', deep: 'ok', back: new Date(0) });
  });

  test('exposeFunction and addInitScript', async ({ page }) => {
    await page.exposeFunction('double', (n: number) => n * 2);
    await page.addInitScript(() => {
      (window as unknown as { early: string }).early = 'before page scripts';
    });
    await page.goto('/page/nav-b.html');
    expect(await page.evaluate(() => (window as unknown as { early: string }).early)).toBe('before page scripts');
    expect(await page.evaluate(() => (window as unknown as { double: (n: number) => Promise<number> }).double(21))).toBe(42);
  });

  test('evaluateHandle and JSHandle', async ({ page }) => {
    await page.goto('/page/nav-b.html');
    const h = await page.evaluateHandle(() => document.querySelector('h1'));
    expect(await h.evaluate((el) => (el as HTMLElement).textContent)).toBe('B');
  });

  test('setContent and content', async ({ page }) => {
    await page.setContent('<main><p>Set from the test</p></main>');
    await expect(page.getByText('Set from the test')).toBeVisible();
    expect(await page.content()).toContain('<main>');
  });

  test('back, forward, reload, waitForURL', async ({ page }) => {
    await page.goto('/page/nav-a.html');
    await page.getByRole('link', { name: 'To B' }).click();
    await page.waitForURL('**/nav-b.html');
    await page.goBack();
    await expect(page).toHaveURL(/nav-a\.html$/);
    await page.goForward();
    await expect(page).toHaveURL(/nav-b\.html$/);
    await page.reload();
    await expect(page.getByRole('heading')).toHaveText('B');
  });

  test('waitForFunction', async ({ page }) => {
    await page.goto('/page/timer.html');
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
    await expect(page.locator('#o')).toHaveText('ready');
  });

  test('dialogs: confirm and prompt', async ({ page }) => {
    await page.goto('/page/dialogs.html');
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('#o')).toHaveText('yes');
    page.once('dialog', (d) => d.accept('Ada'));
    await page.getByRole('button', { name: 'Prompt' }).click();
    await expect(page.locator('#o')).toHaveText('Ada');
  });

  test('screenshots: element and page', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 300 });
    await page.goto('/page/visual.html');
    const dpr = await page.evaluate(() => devicePixelRatio);
    const shot = await page.locator('#box').screenshot();
    expect(shot.subarray(1, 4).toString()).toBe('PNG');
    expect(shot.readUInt32BE(16)).toBe(120 * dpr);
    const full = await page.screenshot();
    expect(full.readUInt32BE(16)).toBe(400 * dpr);
    expect(await page.locator('#box').boundingBox()).toMatchObject({ width: 120, height: 80 });
  });

  test('each test starts with its own storage', async ({ page }) => {
    await page.goto('/page/storage.html');
    await expect(page.locator('#o')).toHaveText('empty');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.reload();
    await expect(page.locator('#o')).toHaveText('had v');
  });

  test('a second test sees none of the first one\'s storage', async ({ page }) => {
    await page.goto('/page/storage.html');
    await expect(page.locator('#o')).toHaveText('empty');
  });

  test('a second page in the same context shares storage', async ({ page, context }) => {
    await page.goto('/page/storage.html');
    await page.getByRole('button', { name: 'Save' }).click();
    const other = await context.newPage();
    await other.goto('/page/storage.html');
    await expect(other.locator('#o')).toHaveText('had v');
  });
});

test.describe('pointer', () => {
  test('mouse click at coordinates on a canvas', async ({ page }) => {
    await page.goto('/canvas/draw.html');
    const box = (await page.locator('#c').boundingBox())!;
    await page.mouse.click(box.x + 50, box.y + 40);
    await expect(page.locator('#o')).toHaveAttribute('data-click', /^(49|50|51),(39|40|41)$/);
  });

  test('mouse drag draws a stroke', async ({ page }) => {
    await page.goto('/canvas/draw.html');
    const box = (await page.locator('#c').boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 150, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator('#o')).toHaveText(/stroke \d+/);
  });

  test('a range slider by keyboard', async ({ page }) => {
    await page.goto('/canvas/slider.html');
    await page.getByLabel('Volume').focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await expect(page.locator('#o')).toHaveText('5');
  });
});
