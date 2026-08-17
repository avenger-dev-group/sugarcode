import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampDrawioScale,
  resolveDrawioFitScale,
} from '../../src/renderer/components/workspace/drawio/drawio-viewport.ts';

test('Draw.io fit waits until the rail is wider than its margins', () => {
  assert.equal(
    resolveDrawioFitScale({
      containerHeight: 800,
      containerWidth: 63,
      graphHeight: 500,
      graphWidth: 800,
    }),
    null,
  );
});

test('Draw.io viewport never accepts a negative or unbounded scale', () => {
  assert.equal(
    resolveDrawioFitScale({
      containerHeight: 80,
      containerWidth: 80,
      graphHeight: 500,
      graphWidth: 800,
    }),
    0.2,
  );
  assert.equal(clampDrawioScale(-0.02), 0.2);
  assert.equal(clampDrawioScale(Number.NaN), 1);
  assert.equal(clampDrawioScale(12), 4);
  assert.equal(
    resolveDrawioFitScale({
      containerHeight: 800,
      containerWidth: Number.NaN,
      graphHeight: 500,
      graphWidth: 800,
    }),
    null,
  );
});
