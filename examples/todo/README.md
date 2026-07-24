# testsurfer example: todo app

A small todo app and an e2e suite for it. The tests import `testsurfer` as a package dependency, so this doubles as a consumer test of the published module shape.

## Run it

From the repo root, build the library once:

```sh
npm install
npm run build
```

Then in this directory:

```sh
npm install
npm test
```

The tests spawn their own app server on a random port and drive it through the local vibesurfer daemon. If no daemon is running, testsurfer starts one via `vs` on your PATH or an npx-fetched pinned binary.

To click around the app yourself:

```sh
npm start
# surf todos running at http://127.0.0.1:4173/
```

## What the tests show

- `getByRole`, `getByLabel`, and `getByText` locators against the accessibility tree, no CSS selectors anywhere
- actions that auto-wait (`fill`, `click`) and assertions that poll (`toBeVisible`, `toHaveCount`, `toBeHidden`)
- `.first()` for picking one match when a label appears twice
- the `{ page }` fixture from the node:test wrapper, one fresh page per test
