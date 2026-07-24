import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHidden, parseFullTree, parseTreeLine, walk } from '../src/tree.ts';

const SAMPLE = [
  '1 doc "Example Domain"',
  '  2 hd "Example Domain" level=1',
  '  3 p "This domain is for use in illustrative examples..."',
  '  4 lnk "More information..." click href=https://www.iana.org/domains/example',
];

test('parses the spec sample tree', () => {
  const snap = parseFullTree(SAMPLE);
  assert.deepEqual(snap.roots, [1]);
  assert.equal(snap.nodes.size, 4);
  const link = snap.nodes.get(4)!;
  assert.equal(link.role, 'lnk');
  assert.equal(link.label, 'More information...');
  assert.deepEqual(link.ops, ['click']);
  assert.equal(link.attrs['href'], 'https://www.iana.org/domains/example');
  assert.equal(link.parent, 1);
  assert.deepEqual(snap.nodes.get(1)!.children, [2, 3, 4]);
  const hd = snap.nodes.get(2)!;
  assert.equal(hd.attrs['level'], '1');
});

test('walk yields depth-first order', () => {
  const snap = parseFullTree(SAMPLE);
  assert.deepEqual([...walk(snap)].map((n) => n.ref), [1, 2, 3, 4]);
});

test('label always occupies slot two, even when it collides with an op name', () => {
  const node = parseTreeLine('5 btn click click', 0)!;
  assert.equal(node.label, 'click');
  assert.deepEqual(node.ops, ['click']);
});

test('multiple ops parse as a list', () => {
  const node = parseTreeLine('9 tf "Email" click,fill,focus placeholder="you@example.com"', 0)!;
  assert.deepEqual(node.ops, ['click', 'fill', 'focus']);
  assert.equal(node.attrs['placeholder'], 'you@example.com');
});

test('empty label parses', () => {
  const node = parseTreeLine('7 img ""', 0)!;
  assert.equal(node.label, '');
});

test('hidden attribute is inherited from ancestors', () => {
  const snap = parseFullTree(['1 doc "t"', '  2 sec "" hid=1', '    3 btn "Save" click', '  4 btn "Save" click']);
  assert.equal(isHidden(snap, snap.nodes.get(3)!), true);
  assert.equal(isHidden(snap, snap.nodes.get(4)!), false);
});

test('nested siblings attach to the right parents', () => {
  const snap = parseFullTree(['1 doc "t"', '  2 lst ""', '    3 li "a"', '    4 li "b"', '  5 p "tail"']);
  assert.deepEqual(snap.nodes.get(2)!.children, [3, 4]);
  assert.deepEqual(snap.nodes.get(1)!.children, [2, 5]);
});
