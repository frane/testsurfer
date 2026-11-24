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

`page.on(event, listener)` (and `once`, `off`) reports `console` (`msg.type()`, `msg.text()`, `msg.args()`, `msg.worker()`), `pageerror`, `request`, `response`, `requestfinished`, `requestfailed`, `load`, `domcontentloaded`, `framenavigated`, `popup`, `dialog`, `download`, `filechooser`, `websocket`, `worker`, `crash` and `close`. Console messages and page errors a call caused arrive before the call returns. `page.waitForRequest(url)`, `page.waitForResponse(url)` and `page.waitForEvent(name, predicate)` wait for one; `page.consoleMessages()`, `page.pageErrors()` and `page.requests()` return the recent ones.

## How requests are seen

Every request goes through vibesurfer's intercepting proxy, http and https: documents, iframes, scripts, stylesheets, images, fetch and XHR, each redirect hop on its own, on any host including `localhost` and `127.0.0.1`. All of them are reported and routable, `page.goto` returns the real response, `setExtraHTTPHeaders` reaches every request, and the context's cookies are one jar for the pages, `context.cookies()` and `page.request`. Popups open as their own pages (`page.on('popup')`, `context.on('page')`, `page.opener()`, `close` when they call `window.close()`), `page.on('dialog')` gets `alert`, `confirm` and `prompt` to accept or dismiss (with no listener they are dismissed, as in Playwright), and responses a service worker hands on or builds itself report `fromServiceWorker()`.

`configure({ network: 'shim' })` turns the proxy off: a script in the page then sees `fetch` and XHR only, and popups load in place.

## WebSockets and HAR

`page.routeWebSocket(url, handler)` answers a page's WebSockets from the test; `ws.connectToServer()` puts the real server behind it, and `onMessage` on either side takes the messages instead of passing them on. `page.on('websocket')` reports every socket with its `framesent` and `framereceived` events.

`page.routeFromHAR(file, { url, notFound, update })` answers matching requests from a HAR file (`.har` or `.zip`); with `update` it records them instead. The `recordHar` context option writes every request of a context.
