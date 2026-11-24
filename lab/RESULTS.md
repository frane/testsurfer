# testsurfer lab

84 cases, each a small page in `fixtures/` and a test in `tests/` written against `@playwright/test`. The same files run on Playwright's WebKit and on testsurfer (`testsurfer test` reads `playwright.config.ts`; `testsurfer.config.ts` adds the proxy network mode). 2026-11-23, darwin arm64, vibesurfer 0.2.18, Playwright 1.61.1. Reproduce with `node lab/run.mjs`.

| | testsurfer | Playwright WebKit |
| --- | --- | --- |
| cases passed | 84 of 84 | 83 of 84 |
| wall time, whole lab | 12.6 s | 35.9 s |
| install | 10.4 MB (testsurfer source and the vs binary) | 308.4 MB (Playwright packages and its WebKit build) |

Wall time includes starting the fixture server and, for testsurfer, the vibesurfer daemon if it was not running. The config sets `fullyParallel`: Playwright spreads the tests over its default workers; testsurfer runs one process per file and up to four tests of a file at a time.

| area | case | testsurfer | Playwright WebKit |
| --- | --- | --- | --- |
| actions | click is a trusted event | pass | pass |
| actions | dblclick | pass | pass |
| actions | right click opens a context menu handler | pass | pass |
| actions | click with modifiers | pass | pass |
| actions | hover reveals a CSS :hover menu | pass | pass |
| actions | fill fires input events | pass | pass |
| actions | fill and type into contenteditable | pass | pass |
| actions | Enter submits a form | pass | pass |
| actions | check, uncheck, radio, switch | pass | pass |
| actions | selectOption by label, value, several | pass | pass |
| actions | setInputFiles from disk and from a buffer | pass | pass |
| actions | dragTo fires the HTML5 drag events | pass | pass |
| actions | click waits until an overlay is gone | pass | pass |
| actions | click scrolls inside a scroll container | pass | pass |
| actions | focus and blur | pass | pass |
| actions | click waits for a disabled button to enable | pass | pass |
| assertions | value, enabled, editable, checked, empty | pass | pass |
| assertions | attribute, class, CSS, id, JS property | pass | pass |
| assertions | toHaveText with arrays and normalized whitespace | pass | pass |
| assertions | page title and URL | pass | pass |
| assertions | toBeInViewport | pass | pass |
| assertions | accessible name, description, role | pass | pass |
| assertions | toMatchAriaSnapshot | pass | pass |
| assertions | expect.poll and soft assertions | pass | pass |
| assertions | a failed assertion names the locator and the value | pass | pass |
| dynamic pages | an element that appears later | pass | pass |
| dynamic pages | clicks land while the element is re-rendered | pass | FAIL |
| dynamic pages | a list that grows | pass | pass |
| dynamic pages | debounced search results | pass | pass |
| dynamic pages | client-side routing | pass | pass |
| dynamic pages | content from fetch | pass | pass |
| dynamic pages | waitFor detached | pass | pass |
| frames | frameLocator into a same-origin iframe | pass | pass |
| frames | nested iframes | pass | pass |
| frames | srcdoc iframe | pass | pass |
| frames | frames() and frame.evaluate | pass | pass |
| frames | a cross-origin iframe | pass | pass |
| shadow DOM | slotted content and shadow buttons | pass | pass |
| shadow DOM | a form inside a custom element | pass | pass |
| popups | window.open gives a popup with an opener | pass | pass |
| popups | target=_blank opens a new page in the context | pass | pass |
| popups | a popup that closes itself | pass | pass |
| locators | getByRole with name, exact and substring | pass | pass |
| locators | getByLabel: for, wrapping, aria-labelledby | pass | pass |
| locators | aria-label names | pass | pass |
| locators | getByPlaceholder | pass | pass |
| locators | getByAltText and getByTitle | pass | pass |
| locators | getByTestId scopes a chain | pass | pass |
| locators | getByText: substring, exact, RegExp | pass | pass |
| locators | CSS pierces open shadow roots | pass | pass |
| locators | XPath | pass | pass |
| locators | first, last, nth | pass | pass |
| locators | filter by text, by child, visible | pass | pass |
| locators | and / or | pass | pass |
| locators | strict mode reports every match | pass | pass |
| locators | hidden elements are skipped by role, counted by CSS | pass | pass |
| network | route.fulfill with JSON | pass | pass |
| network | route.fetch and modify the response | pass | pass |
| network | route.abort | pass | pass |
| network | route.continue with an added header | pass | pass |
| network | setExtraHTTPHeaders | pass | pass |
| network | waitForResponse and request events | pass | pass |
| network | a routed document | pass | pass |
| network | an aborted image | pass | pass |
| network | goto follows redirects and returns the final response | pass | pass |
| network | cookies set by the server, and context.addCookies | pass | pass |
| keyboard | Tab and Shift+Tab move focus between fields | pass | pass |
| keyboard | shortcuts with modifiers, Escape | pass | pass |
| keyboard | Backspace and select-all editing | pass | pass |
| keyboard | arrow keys in a listbox | pass | pass |
| page | evaluate with arguments of many types | pass | pass |
| page | exposeFunction and addInitScript | pass | pass |
| page | evaluateHandle and JSHandle | pass | pass |
| page | setContent and content | pass | pass |
| page | back, forward, reload, waitForURL | pass | pass |
| page | waitForFunction | pass | pass |
| page | dialogs: confirm and prompt | pass | pass |
| page | screenshots: element and page | pass | pass |
| page | each test starts with its own storage | pass | pass |
| page | a second test sees none of the first one's storage | pass | pass |
| page | a second page in the same context shares storage | pass | pass |
| pointer | mouse click at coordinates on a canvas | pass | pass |
| pointer | mouse drag draws a stroke | pass | pass |
| pointer | a range slider by keyboard | pass | pass |
