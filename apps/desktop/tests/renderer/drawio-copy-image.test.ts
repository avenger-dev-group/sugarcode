import assert from 'node:assert/strict';
import test from 'node:test';

import { fitDrawioImageDimensions } from '../../src/renderer/components/workspace/drawio/drawio-copy-image.ts';

test('Draw.io PNG dimensions preserve detail while bounding memory use', () => {
  assert.deepEqual(fitDrawioImageDimensions(800, 600), {
    height: 1200,
    width: 1600,
  });
  const large = fitDrawioImageDimensions(12_000, 8_000);
  assert.ok(large.width <= 4096);
  assert.ok(large.height <= 4096);
  assert.ok(large.width * large.height <= 12_000_000);
  assert.ok(Math.abs(large.width / large.height - 1.5) < 0.001);
});
