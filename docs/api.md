# API

testsurfer's API is Playwright's. This page lists what is implemented and where behavior is worth knowing about.

## Locators

Locators resolve lazily at action time, against a fresh view:

- `page.getByRole(role, { name, exact, level, checked, disabled, expanded, pressed, selected, includeHidden })` matches ARIA roles, explicit or implicit (`button`, `textbox`, `heading`, `link`, ...), by accessible name. Name matching is substring and case-insensitive by default; `exact: true` makes it whole-string and case-sensitive. RegExp names are supported.
- `page.getByText(text, { exact })` matches visible text, substring and case-insensitive by default.
- `page.getByLabel(text, { exact })` matches form fields by their `<label>` (for, wrapping, or `aria-labelledby`) or `aria-label`.
- `page.getByTestId(id)` matches `data-testid` exactly (string or RegExp). The `testIdAttribute` option changes the attribute.
- `page.getByPlaceholder(text)`, `page.getByAltText(text)` and `page.getByTitle(text)` match those attributes, substring and case-insensitive by default, whole-string with `{ exact: true }`.
- `page.locator(selector, { hasText, has })` takes Playwright selectors: CSS (searching open shadow roots, with `:has-text()`, `:text()`, `:text-is()`, `:text-matches()` and `:visible` anywhere), `xpath=` or `//...`, `text=`, `role=button[name="OK"]`, `id=`, `data-testid=`, `nth=`, `visible=`, and `>>` chains.
- `page.frameLocator(selector)` or `locator.contentFrame()` searches inside an iframe; plain locators stay in their own frame, as in Playwright. A cross-origin iframe is searched through vibesurfer, which evaluates inside it directly.
- Every `getBy*` and `locator()` also exists on a locator and searches inside its matches: `page.getByTestId('cart').getByRole('button', { name: 'Remove' })`.
- `.filter({ hasText, hasNotText, has, hasNot, visible })` narrows matches; `has` and `hasNot` take a locator searched inside each match.
- `.and(locator)` keeps elements matching both, `.or(locator)` takes either.
- `.first()`, `.last()` and `.nth(i)` pick one match when several qualify, and `all()` returns one locator per match. Otherwise a locator that matches more than one element fails the action, like Playwright's strict mode. The selector shorthands on the page (`page.click(selector)` and the rest) act on the first match, as in Playwright, unless you pass `strict: true`.

## Actions and reads

Actions wait until their element is attached, visible, enabled and not covered by another element, then act: `click()` (trusted native click; `button`, `modifiers`, `clickCount` and `position` options), `dblclick()`, `hover()`, `fill(value)`, `clear()`, `pressSequentially(text)` / `type(text)` (trusted native keystrokes, for rich-text editors), `press(key)`, `check()`, `uncheck()`, `setChecked()`, `selectOption()`, `setInputFiles()`, `focus()`, `blur()`, `dispatchEvent()`, `scrollIntoViewIfNeeded()`, `selectText()`, `dragTo(locator)`, `waitFor({ state })`.

Reads: `textContent()`, `innerText()`, `innerHTML()`, `inputValue()`, `getAttribute(name)`, `isChecked()`, `isVisible()`, `isHidden()`, `isEnabled()`, `isDisabled()`, `isEditable()`, `boundingBox()`, `count()`, `all()`, `allTextContents()`, `allInnerTexts()`, `evaluate(fn, arg)`, `evaluateAll(fn, arg)`, `screenshot()`, `ariaSnapshot()`, `elementHandle()`. Element handles (`page.$`, `page.$$`, `elementHandle()`) are locators pinned to one element, so every locator method works on them.

Clicks and keystrokes dispatch as native OS input. The cadence is configurable per browser: the default `inputMode: 'robotic'` is instant, which is what tests want; `'human'` moves the cursor along a humanized path with realistic timing for flows that score input behavior.

## Assertions

Assertions poll until they pass or time out, and fail with Playwright's message layout:

- `expect(locator).toBeVisible()` / `.toBeHidden()` / `.toBeAttached()` / `.toBeInViewport({ ratio })`
- `expect(locator).toHaveText(value)` / `.toContainText(value)` (string, RegExp or an array for several matches; `ignoreCase`, `useInnerText`)
- `expect(locator).toHaveValue(value)` / `.toHaveValues(values)` / `.toBeChecked({ checked, indeterminate })` / `.toBeEmpty()`
- `expect(locator).toBeEnabled()` / `.toBeDisabled()` / `.toBeEditable()` / `.toBeFocused()`
- `expect(locator).toHaveAttribute(name, value?)` / `.toHaveClass(value)` / `.toContainClass(value)` / `.toHaveId(value)` / `.toHaveCSS(name, value)` / `.toHaveJSProperty(name, value)`
- `expect(locator).toHaveRole(role)` / `.toHaveAccessibleName(name)` / `.toHaveAccessibleDescription(text)`
- `expect(locator).toHaveCount(n)`
- `expect(response).toBeOK()`, and the generic matchers (`toBe`, `toEqual`, `toMatchObject`, `toThrow`, ...), `expect.poll`, `expect.soft` and `expect.configure`
- `expect(locator).toHaveScreenshot(name?, { threshold, maxDiffPixels, maxDiffPixelRatio })` / `expect(page).toHaveScreenshot(...)` compare against a baseline PNG stored next to the test file, in `<file>-snapshots/<name>-<os>.png`. A missing baseline is written and fails the test once; a mismatch writes the actual image and a diff to `outputDir`. `TESTSURFER_UPDATE_SNAPSHOTS=1` rewrites baselines.
- `expect(locator).toMatchAriaSnapshot(template)` / `expect(page).toMatchAriaSnapshot(template)`
- `expect(page).toHaveTitle(value)` / `.toHaveURL(value)`
- every matcher takes `{ timeout }` and negates with `.not`

## Tree snapshots

`toMatchAriaSnapshot` compares part of the page against a template of roles and names:

```ts
await expect(page.getByRole('main')).toMatchAriaSnapshot(`
  - heading "Settings" [level=1]
  - textbox "Work email"
  - checkbox "Send me news" [checked]
  - list:
    - listitem "Alpha"
    - listitem /bravo/i
`);
```

Template siblings must appear in that order, and a child can sit at any depth under its parent, so wrapper elements do not break a template. Nodes the template does not mention are ignored. A name in quotes matches the whole name; `/regex/flags` is tested as written; no name matches any. `[level=N]` and `[checked]` constrain headings and checkboxes. A form field is printed under its `<label>` text when it has one; in a template, either that text or the field's current value names it. `await locator.ariaSnapshot()` (or `page.ariaSnapshot()`) prints the current tree in this format, ready to paste in and trim.

## The page

- A new page starts at `about:blank`. `page.goto(url)` navigates and returns the main document's response (status, headers, body); relative URLs resolve against the `baseURL` option. `page.setContent(html)` and `page.content()` set and read the document.
- `page.evaluate(fn, arg)` runs in the page and awaits promises; values round-trip with their types (`undefined`, `Date`, `RegExp`, `Map`, `Set`, `BigInt`, ...), and handles can be passed in. `page.evaluateHandle`, `page.$eval`, `page.$$eval`, `page.waitForFunction` (resolves to a handle) and `page.exposeFunction` / `exposeBinding` work as in Playwright.
- `page.addScriptTag({ url | path | content })` and `page.addStyleTag(...)` add a script or stylesheet and wait for it to load.
- `page.emulateMedia({ media, colorScheme, reducedMotion, forcedColors })` makes `matchMedia` and the page's readable `@media` rules follow. `media` attributes on `<link>` and cross-origin stylesheets do not.
- `page.screenshot({ path, fullPage, clip })` returns the PNG and writes it to `path` when given. The viewport is 1280x720 by default; `page.setViewportSize()` changes it.
- `page.keyboard.press(key)`, `down`, `up`, `insertText` and `type`, with the browser's default actions (Enter submits a form, Tab moves focus, Backspace deletes).
- `page.mainFrame()`, `page.frames()` and `page.frame(name)` reach iframes, with `evaluate` running in the frame's own window, cross-origin ones included.
- `page.click(selector)`, `page.fill(selector, value)` and the rest of the selector shorthands, `page.waitForSelector`, `page.waitForNavigation`, `page.addLocatorHandler`.
- `page.mouse.move(x, y)`, `page.mouse.click(x, y)`, `page.mouse.down()` / `up()` and `page.mouse.drag(x1, y1, x2, y2)` send trusted pointer input at viewport coordinates, for canvas, maps, sliders and other surfaces with no accessibility tree. A drag also fires the HTML5 drag events, so native `draggable` lists see the drop. `page.mouse.wheel(dx, dy)` dispatches a wheel event (not trusted) and scrolls.
- `page.reload()`, `page.goBack()`, `page.goForward()`, `page.waitForURL(url)`, `page.waitForTimeout(ms)`.
- `page.addInitScript(fn | string | { path }, arg)` runs a script at document start in every later document, before the page's own scripts. The page's Content Security Policy does not block it.

## Logging in once

`page.saveAuth(name)` stores the page's cookies, local and session storage, and IndexedDB, encrypted by the daemon. `page.loadAuth(name)` restores them in a later run; `page.clearAuth(name)` deletes them. Storage is per origin, so load on a page of the same site, then navigate:

```ts
// once, after logging in through the UI
await page.saveAuth('staging-admin');

// every run after that
configure({ auth: { name: 'staging-admin', url: 'https://staging.example.com/' } });
```

With the `auth` option, every test's `page` starts logged in.
