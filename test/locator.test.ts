import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFullTree } from '../src/tree.ts';
import { findMatches, type TreeQuery as LocatorQuery } from '../src/locator.ts';

const snap = parseFullTree([
  '1 doc "Login"',
  '  2 hd "Sign in to continue" level=1',
  '  3 tf "Email" click,fill,focus',
  '  4 tf "Password" click,fill,focus',
  '  5 btn "Sign in" click',
  '  6 btn "Sign in" click hid=1',
  '  7 lnk "Forgot password?" click',
]);

const byRole = (role: string, name?: string | RegExp, exact?: boolean): LocatorQuery => ({
  kind: 'role',
  role,
  options: exact === undefined ? (name === undefined ? {} : { name }) : { ...(name === undefined ? {} : { name }), exact },
});

test('getByRole maps ARIA roles to wire codes', () => {
  assert.deepEqual(findMatches(snap, byRole('button', 'Sign in')).map((n) => n.ref), [5, 6]);
  assert.deepEqual(findMatches(snap, byRole('textbox')).map((n) => n.ref), [3, 4]);
  assert.deepEqual(findMatches(snap, byRole('link')).map((n) => n.ref), [7]);
});

test('role name match is whole-string and case-insensitive by default', () => {
  assert.equal(findMatches(snap, byRole('button', 'sign in')).length, 2);
  assert.equal(findMatches(snap, byRole('button', 'Sign')).length, 0);
  assert.equal(findMatches(snap, byRole('button', 'sign in', true)).length, 0);
  assert.equal(findMatches(snap, byRole('button', 'Sign in', true)).length, 2);
});

test('role name accepts a RegExp', () => {
  assert.equal(findMatches(snap, byRole('heading', /sign in/i)).length, 1);
});

test('heading level filters', () => {
  assert.equal(findMatches(snap, { kind: 'role', role: 'heading', options: { level: 1 } }).length, 1);
  assert.equal(findMatches(snap, { kind: 'role', role: 'heading', options: { level: 2 } }).length, 0);
});

test('getByText is substring and case-insensitive by default', () => {
  const q: LocatorQuery = { kind: 'text', text: 'forgot', options: {} };
  assert.deepEqual(findMatches(snap, q).map((n) => n.ref), [7]);
  const exact: LocatorQuery = { kind: 'text', text: 'forgot', options: { exact: true } };
  assert.equal(findMatches(snap, exact).length, 0);
});

test('getByLabel targets form fields', () => {
  const q: LocatorQuery = { kind: 'label', text: 'email', options: {} };
  assert.deepEqual(findMatches(snap, q).map((n) => n.ref), [3]);
  const heading: LocatorQuery = { kind: 'label', text: 'Sign in to continue', options: {} };
  assert.equal(findMatches(snap, heading).length, 0);
});

test('getByLabel and role names see the <label> text of a field (lbl=)', () => {
  const s = parseFullTree([
    '1 doc ""',
    '  2 tf "a@b.com" fill,focus lbl="Work email"',
    '  3 chk on click,focus lbl="Accept terms"',
    '  4 mn ""',
  ]);
  assert.deepEqual(findMatches(s, { kind: 'label', text: 'work email', options: {} }).map((n) => n.ref), [2]);
  assert.deepEqual(findMatches(s, byRole('checkbox', 'Accept terms')).map((n) => n.ref), [3]);
  assert.deepEqual(findMatches(s, byRole('textbox', 'a@b.com')).map((n) => n.ref), [2]);
  assert.deepEqual(findMatches(s, byRole('main')).map((n) => n.ref), [4]);
});
