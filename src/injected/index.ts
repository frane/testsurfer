// @ts-nocheck
/**
 * The page-side locator engine, installed lazily as `window.__tse`.
 *
 * Playwright locators address DOM elements, and most of the DOM (a
 * plain `<div>` with text) never reaches vibesurfer's accessibility
 * tree, so locators resolve here, in the page: CSS (piercing open
 * shadow roots), XPath, text, role, label and attribute queries,
 * chained, filtered and indexed, in one evaluate per call. vibesurfer
 * still supplies trusted pointer input, layout and screenshots.
 *
 * The modules here are plain browser JavaScript (excluded from type
 * checking). scripts/build-injected.mjs bundles them, from this entry,
 * into one self-contained function, `installEngine(SER)`, written to
 * src/injected.gen.ts; the page evaluates it with the serializer
 * (src/serialize.ts) as SER, a free variable in these modules. The
 * imports below fix the order the modules initialize in.
 */

import './realm.ts';
import './basics.ts';
import './text.ts';
import './visibility.ts';
import './roles.ts';
import './css.ts';
import './descriptions.ts';
import './handles.ts';
import './resolution.ts';
import './input.ts';
export { api } from './ops.ts';
