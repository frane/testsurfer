import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDelta, isDeltaBody, isHidden, parseFullTree, parseTreeLine, walk } from '../src/tree.ts';

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

test('delta bodies are recognized by their first line', () => {
  assert.equal(isDeltaBody('+9@1 btn "Save" click'), true);
  assert.equal(isDeltaBody('-4'), true);
  assert.equal(isDeltaBody('~3 hid=1'), true);
  assert.equal(isDeltaBody('>5@1:0'), true);
  assert.equal(isDeltaBody('*2'), true);
  assert.equal(isDeltaBody('1 doc "Example Domain"'), false);
});

test('delta add inserts under the parent at the position', () => {
  const snap = parseFullTree(['1 doc "t"', '  2 p "a"', '  3 p "b"']);
  applyDelta(snap, ['+9@1:1 btn "Save" click']);
  assert.deepEqual(snap.nodes.get(1)!.children, [2, 9, 3]);
  const added = snap.nodes.get(9)!;
  assert.equal(added.role, 'btn');
  assert.equal(added.label, 'Save');
  assert.deepEqual(added.ops, ['click']);
  assert.equal(added.parent, 1);
});

test('delta add without position appends', () => {
  const snap = parseFullTree(['1 doc "t"', '  2 p "a"']);
  applyDelta(snap, ['+9@1 p "tail"']);
  assert.deepEqual(snap.nodes.get(1)!.children, [2, 9]);
});

test('delta remove drops the whole subtree', () => {
  const snap = parseFullTree(['1 doc "t"', '  2 lst ""', '    3 li "a"', '  4 p "b"']);
  applyDelta(snap, ['-2']);
  assert.equal(snap.nodes.has(2), false);
  assert.equal(snap.nodes.has(3), false);
  assert.deepEqual(snap.nodes.get(1)!.children, [4]);
});

test('delta update replaces the attribute map', () => {
  const snap = parseFullTree(['1 doc "t"', '  2 btn "Save" click hid=1']);
  applyDelta(snap, ['~2 level=2']);
  assert.deepEqual(snap.nodes.get(2)!.attrs, { level: '2' });
});

test('delta move reparents and reorders', () => {
  const snap = parseFullTree(['1 doc "t"', '  2 lst ""', '    3 li "a"', '  4 p "b"']);
  applyDelta(snap, ['>4@2:0']);
  assert.deepEqual(snap.nodes.get(2)!.children, [4, 3]);
  assert.equal(snap.nodes.get(4)!.parent, 2);
  assert.deepEqual(snap.nodes.get(1)!.children, [2]);
});

test('delta replace swaps the subtree in place', () => {
  const snap = parseFullTree(['1 doc "t"', '  2 lst ""', '    3 li "old"', '  4 p "b"']);
  applyDelta(snap, ['*2', '  2 lst ""', '    5 li "new"', '    6 li "newer"']);
  assert.deepEqual(snap.nodes.get(1)!.children, [2, 4]);
  assert.deepEqual(snap.nodes.get(2)!.children, [5, 6]);
  assert.equal(snap.nodes.has(3), false);
  assert.equal(snap.nodes.get(6)!.label, 'newer');
});

test('mixed delta ops apply in order', () => {
  const snap = parseFullTree(['1 doc "t"', '  2 p "a"', '  3 p "b"']);
  applyDelta(snap, ['-2', '+7@1 hd "New" level=1', '~3 hid=1']);
  assert.deepEqual(snap.nodes.get(1)!.children, [3, 7]);
  assert.equal(snap.nodes.get(7)!.attrs['level'], '1');
  assert.equal(isHidden(snap, snap.nodes.get(3)!), true);
});

test('nested siblings attach to the right parents', () => {
  const snap = parseFullTree(['1 doc "t"', '  2 lst ""', '    3 li "a"', '    4 li "b"', '  5 p "tail"']);
  assert.deepEqual(snap.nodes.get(2)!.children, [3, 4]);
  assert.deepEqual(snap.nodes.get(1)!.children, [2, 5]);
});
