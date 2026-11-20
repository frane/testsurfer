import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { decodePng, diffImages, encodePng } from '../src/png.ts';

test('png round trip and diff', () => {
  const img = { width: 3, height: 2, data: new Uint8Array(3 * 2 * 4) };
  for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 37) % 256;
  const back = decodePng(encodePng(img));
  assert.equal(back.width, 3);
  assert.equal(back.height, 2);
  assert.deepEqual([...back.data], [...img.data]);
  const changed = { ...back, data: back.data.slice() };
  changed.data[0] = (changed.data[0]! + 200) % 256;
  assert.equal(diffImages(back, changed, 0.1).diffPixels, 1);
  assert.equal(diffImages(back, back, 0).diffPixels, 0);
});
