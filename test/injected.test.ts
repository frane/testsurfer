/**
 * src/injected.gen.ts is generated from src/injected/*.ts; the page
 * runs the generated copy, so it must match the sources.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error: a plain .mjs build script without type declarations
import { generated } from '../scripts/build-injected.mjs';

test('src/injected.gen.ts is built from the current src/injected sources', async () => {
  const committed = readFileSync(new URL('../src/injected.gen.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, await generated(), 'run npm run build:injected');
});

test('the engine source is one self-contained function', async () => {
  const { ENGINE_SOURCE } = await import('../src/injected.gen.ts');
  assert.match(ENGINE_SOURCE, /^function installEngine\(SER\) \{/);
  assert.doesNotMatch(ENGINE_SOURCE, /\brequire\(|\bimport\s*\(|^import /m);
  assert.equal(typeof new Function(`return (${ENGINE_SOURCE})`)(), 'function');
});
