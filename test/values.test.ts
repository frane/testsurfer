import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { expect } from '../src/index.ts';

test('value matchers', async () => {
  expect(3).toBe(3);
  expect({ a: 1, b: undefined }).toEqual({ a: 1 });
  expect([1, 2, 3]).toContain(2);
  expect('hello world').toMatch(/world/);
  expect({ a: { b: 2 } }).toHaveProperty('a.b', 2);
  expect([1, 2]).toHaveLength(2);
  expect(5).toBeGreaterThan(4);
  expect(0.1 + 0.2).toBeCloseTo(0.3);
  expect(() => {
    throw new Error('boom');
  }).toThrow('boom');
  expect({ id: 7, name: 'x' }).toEqual({ id: expect.any(Number), name: expect.stringContaining('x') });
  expect(1).not.toBe(2);
  await expect(Promise.resolve(4)).resolves.toBe(4);
  await expect(Promise.reject(new Error('no'))).rejects.toThrow('no');
  assert.throws(() => expect(1).toBe(2), /expected 1 to be 2/);
  let n = 0;
  await expect.poll(() => ++n, { intervals: [5] }).toBeGreaterThan(3);
});
