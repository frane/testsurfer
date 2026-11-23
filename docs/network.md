# Network and events

## Routes

`page.route(url, handler, { times })` intercepts requests whose URL matches a glob (`**/api/*`), a RegExp or a predicate. The handler gets a route:

```ts
await page.route('**/api/items', (route) => route.fulfill({ json: { items: ['mocked'] } }));
await page.route('**/api/items', async (route) => {
  const res = await route.fetch();
  await route.fulfill({ response: res, json: { ...(await res.json()), extra: true } });
});
await page.route('**/analytics/**', (route) => route.abort());
```

`fulfill({ status, headers, contentType, body, json, path, response })`, `continue({ url, method, headers, postData })`, `abort()`, `fallback()` (the next matching handler decides) and `fetch()` work as in Playwright. Routes added later win. Register routes before `goto` to catch requests made while the page loads; routes added afterwards apply from then on. `page.unroute(url)` and `page.unrouteAll()` remove them, and `context.route()` covers every page in a context.

## Events

`page.on(event, listener)` (and `once`, `off`) reports `console` (`msg.type()`, `msg.text()`, `msg.args()`), `pageerror`, `request`, `response`, `requestfinished` and `requestfailed`. Console messages and page errors a call caused arrive before the call returns. `page.waitForRequest(url)`, `page.waitForResponse(url)` and `page.waitForEvent(name, predicate)` wait for one.

## Two network modes

**`shim` (default).** A script testsurfer installs in the page sees what page script does: `fetch`, `XMLHttpRequest`, `console`, uncaught errors. While a page has routes, each `fetch` and XHR waits a poll interval (15ms) for the handler's decision. A route that matches a `page.goto` URL also serves the main document, on any host.

**`proxy`.** With `configure({ network: 'proxy' })` every request goes through vibesurfer's intercepting proxy, http and https: documents, iframes, scripts, stylesheets, images, fetch and XHR, each redirect hop on its own. All of them are reported and routable, `page.goto` returns the real response, `setExtraHTTPHeaders` reaches every request, and `context.addCookies` sets cookies in the context's jar. Popups open as their own pages (`page.on('popup')`, `context.on('page')`, `page.opener()`, `close` when they call `window.close()`), `page.on('dialog')` gets `alert`, `confirm` and `prompt` to accept or dismiss (with no listener they are dismissed, as in Playwright), and a response a service worker handed on reports `fromServiceWorker()`.

Limits of proxy mode:

- On macOS, WebKit sends requests to `localhost` and `127.0.0.1` around any proxy. Serve the app under a `.localhost` name (`http://app.localhost:3000`), which resolves to the same loopback address.
- Popups and dialogs are macOS only. Other platforms load popups in the page that opened them and dismiss dialogs.
