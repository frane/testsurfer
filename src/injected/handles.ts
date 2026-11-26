// @ts-nocheck
/**
 * Page values the test holds by id (JSHandle, ElementHandle).
 *
 * Part of the page-side locator engine (see src/injected/index.ts):
 * plain browser JavaScript, bundled into one script by
 * scripts/build-injected.mjs.
 */

import { Map } from './realm.ts';

// Handles: page values the test holds by id (JSHandle, ElementHandle).
export const HANDLES = new Map();
let handleSeq = 0;
export const adopt = (v) => {
  const id = ++handleSeq;
  HANDLES.set(id, v);
  return id;
};
SER.H.get = (id) => HANDLES.get(id);
export const isEl = (v) => !!v && typeof v === 'object' && (v.nodeType === 1 || v.nodeType === 9 || v.nodeType === 11);
