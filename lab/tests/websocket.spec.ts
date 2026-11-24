import { test, expect } from '@playwright/test';

const wsURL = () => `ws://127.0.0.1:${process.env.LAB_PORT ?? 4173}/ws`;

test.describe('websocket', () => {
  test('page.on(websocket) reports frames both ways', async ({ page }) => {
    await page.goto('/page/nav-a.html');
    const [ws] = await Promise.all([
      page.waitForEvent('websocket'),
      page.evaluate((u) => { const s = new WebSocket(u); (window as any).__got = new Promise((r) => (s.onmessage = (e) => r(e.data))); s.onopen = () => s.send('hi'); }, wsURL()),
    ]);
    expect(ws.url()).toBe(wsURL());
    const sent = ws.waitForEvent('framesent');
    const received = ws.waitForEvent('framereceived');
    expect((await sent).payload).toBe('hi');
    expect((await received).payload).toBe('echo:hi');
    expect(await page.evaluate(() => (window as any).__got)).toBe('echo:hi');
  });

  test('routeWebSocket answers without a server', async ({ page }) => {
    await page.routeWebSocket('**/mock', (ws) => {
      ws.onMessage((m) => ws.send('mocked:' + m));
    });
    await page.goto('/page/nav-a.html');
    const got = await page.evaluate((u) => new Promise((r) => { const s = new WebSocket(u); s.onopen = () => s.send('ping'); s.onmessage = (e) => r(e.data); }), wsURL().replace('/ws', '/mock'));
    expect(got).toBe('mocked:ping');
  });

  test('routeWebSocket with connectToServer changes what the server says', async ({ page }) => {
    await page.routeWebSocket('**/ws', (ws) => {
      const server = ws.connectToServer();
      server.onMessage((m) => ws.send(String(m).toUpperCase()));
    });
    await page.goto('/page/nav-a.html');
    const got = await page.evaluate((u) => new Promise((r) => { const s = new WebSocket(u); s.onopen = () => s.send('abc'); s.onmessage = (e) => r(e.data); }), wsURL());
    expect(got).toBe('ECHO:ABC');
  });
});
