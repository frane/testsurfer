import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesTemplate, parseTemplate, renderSnapshot } from '../src/aria.ts';
import { parseFullTree } from '../src/tree.ts';

const TREE = [
  '1 doc "Todos app"',
  '  3 nav ""',
  '    2 lnk Home click,focus',
  '  21 mn ""',
  '    4 hd Todos level=1',
  '    30 el ""',
  '      8 lst ""',
  '        6 li "Buy milk"',
  '        7 li Walk',
  '    9 tf "" fill,focus lbl=Email',
  '    10 chk on click,focus checked=1 lbl="Accept terms"',
  '    12 btn Add click,focus',
];
const snap = parseFullTree(TREE);
const all = (tmpl: string) => matchesTemplate(snap, snap.roots, parseTemplate(tmpl));

test('parses names, regexes, attrs and nesting', () => {
  const t = parseTemplate('- heading "Todos" [level=1]\n- list:\n  - listitem /milk/i\n- checkbox [checked]');
  assert.equal(t.length, 3);
  assert.equal(t[0]!.name, 'Todos');
  assert.deepEqual(t[0]!.attrs, { level: '1' });
  assert.ok(t[1]!.children[0]!.name instanceof RegExp);
  assert.deepEqual(t[2]!.attrs, { checked: '' });
});

test('rejects a malformed line with its number', () => {
  assert.throws(() => parseTemplate('- heading "x"\nheading'), /line 2/);
});

test('matches in order, through wrappers, ignoring unmentioned nodes', () => {
  assert.ok(all('- heading "Todos" [level=1]\n- list:\n  - listitem "Buy milk"\n  - listitem "Walk"\n- button "Add"'));
});

test('sibling order matters', () => {
  assert.equal(all('- button "Add"\n- heading "Todos"'), false);
});

test('a child must sit under its parent', () => {
  assert.equal(all('- navigation:\n  - heading "Todos"'), false);
  assert.ok(all('- navigation:\n  - link "Home"'));
});

test('names match whole and exact; regex is tested as-is', () => {
  assert.equal(all('- heading "todos"'), false);
  assert.equal(all('- heading "Todo"'), false);
  assert.ok(all('- heading /^todo/i'));
});

test('a field is known by its <label> text too', () => {
  assert.ok(all('- textbox "Email"'));
  assert.ok(all('- checkbox "Accept terms" [checked]'));
  assert.equal(all('- checkbox "Accept terms" [checked=false]'), false);
});

test('level constrains headings', () => {
  assert.equal(all('- heading "Todos" [level=2]'), false);
});

test('render drops unnamed wrappers and round-trips as a template', () => {
  const text = renderSnapshot(snap, snap.roots);
  assert.equal(
    text,
    [
      '- navigation:',
      '  - link "Home"',
      '- main:',
      '  - heading "Todos" [level=1]',
      '  - list:',
      '    - listitem "Buy milk"',
      '    - listitem "Walk"',
      '  - textbox "Email"',
      '  - checkbox "Accept terms" [checked]',
      '  - button "Add"',
    ].join('\n'),
  );
  assert.ok(all(text));
});
