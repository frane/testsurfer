import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRequest, escapeWire, parseEnvelope, parseWarning } from '../src/wire.ts';

test('primitive only', () => {
  assert.equal(encodeRequest('vs_view'), 'vs_view\n');
});

test('args and sorted flags', () => {
  assert.equal(
    encodeRequest('vs_capture', ['7'], { viewport: 'mobile', 'full-page': true }),
    'vs_capture 7 --full-page --viewport=mobile\n',
  );
});

test('arg with spaces is quoted', () => {
  assert.equal(encodeRequest('vs_act', ['2', 'fill', 'with spaces']), 'vs_act 2 fill "with spaces"\n');
});

test('empty arg is quoted', () => {
  assert.equal(encodeRequest('vs_act', ['2', 'fill', '']), 'vs_act 2 fill ""\n');
});

test('multiline arg survives framing', () => {
  const line = encodeRequest('vs_act', ['2', 'fill', 'a\nb']);
  assert.equal(line.match(/\n/g)?.length, 1);
  assert.equal(line, 'vs_act 2 fill a\\nb\n');
});

test('quotes and backslashes escape', () => {
  assert.equal(escapeWire('say "hi" \\ done'), 'say \\"hi\\" \\\\ done');
});

test('flag value with spaces is quoted', () => {
  assert.equal(
    encodeRequest('vs_session_open', [], { policy: 'strict mode' }),
    'vs_session_open --policy="strict mode"\n',
  );
});

test('success envelope', () => {
  assert.deepEqual(parseEnvelope('@a3f9b2c1d4e6f70a'), { ok: true, token: 'a3f9b2c1d4e6f70a' });
});

test('error envelope', () => {
  assert.deepEqual(parseEnvelope('! STALE_TOKEN 9c14e7df0a223f88 nav'), {
    ok: false,
    code: 'STALE_TOKEN',
    args: ['9c14e7df0a223f88', 'nav'],
  });
});

test('warning line', () => {
  assert.deepEqual(parseWarning('? nav https://example.com/login'), {
    code: 'nav',
    args: ['https://example.com/login'],
  });
});
