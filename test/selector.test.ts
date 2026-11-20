import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelector } from '../src/selector.ts';

test('>> splits a chain, but not inside quotes or brackets', () => {
  assert.deepEqual(parseSelector('div >> p').map((p) => p.kind), ['css', 'css']);
  assert.deepEqual(parseSelector('//div[@a="x >> y"]'), [{ kind: 'xpath', xpath: '//div[@a="x >> y"]' }]);
});

test('text= is substring unless quoted', () => {
  assert.deepEqual(parseSelector('text=foo'), [{ kind: 'text', text: 'foo', exact: false }]);
  assert.deepEqual(parseSelector('text="Foo"'), [{ kind: 'text', text: 'Foo', exact: true }]);
  assert.deepEqual(parseSelector('"Hello"'), [{ kind: 'text', text: 'Hello', exact: true }]);
  const [re] = parseSelector('text=/fo+/i');
  assert.ok(re?.kind === 'text' && re.text instanceof RegExp && re.text.flags === 'i');
});

test('trailing CSS pseudos become element checks', () => {
  assert.deepEqual(parseSelector('button:has-text("Hi"):visible'), [
    { kind: 'css', selector: 'button', extras: { visible: true, hasText: ['Hi'] } },
  ]);
  assert.deepEqual(parseSelector(':visible'), [{ kind: 'css', selector: '*', extras: { visible: true } }]);
});

test('engines: nth, role, id, xpath', () => {
  assert.deepEqual(parseSelector('div >> nth=1')[1], { kind: 'nth', index: 1 });
  assert.deepEqual(parseSelector('role=button[name="OK"]'), [{ kind: 'role', role: 'button', options: { name: 'OK' } }]);
  assert.deepEqual(parseSelector('id=foo'), [{ kind: 'attr', attr: 'id', value: 'foo' }]);
  assert.equal(parseSelector('xpath=//a')[0]?.kind, 'xpath');
  assert.throws(() => parseSelector('nope=1'), /unsupported selector engine/);
});
