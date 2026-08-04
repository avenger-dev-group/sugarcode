import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateVisibleGraphViewport } from '../../../src/renderer/components/orchestration/viewport.ts';

const bounds = { x: 24, y: 18, width: 520, height: 330 } as const;

const graphCenterOnScreen = (
  viewport: Readonly<{ x: number; zoom: number }>,
): number => (bounds.x + bounds.width / 2) * viewport.zoom + viewport.x;

test('graph centers inside the clipped conversation width', () => {
  const viewport = calculateVisibleGraphViewport({
    bounds,
    containerWidth: 725,
    containerHeight: 400,
    visibleLeft: 0,
    visibleRight: 300,
    minZoom: 0.45,
    maxZoom: 1.6,
    padding: 0.2,
  });

  assert.ok(viewport);
  assert.ok(Math.abs(graphCenterOnScreen(viewport) - 150) <= 1);
});

test('graph recenters from current geometry after the inspector closes', () => {
  const narrowViewport = calculateVisibleGraphViewport({
    bounds,
    containerWidth: 725,
    containerHeight: 400,
    visibleLeft: 0,
    visibleRight: 300,
    minZoom: 0.45,
    maxZoom: 1.6,
    padding: 0.2,
  });
  const restoredViewport = calculateVisibleGraphViewport({
    bounds,
    containerWidth: 725,
    containerHeight: 400,
    visibleLeft: 0,
    visibleRight: 725,
    minZoom: 0.45,
    maxZoom: 1.6,
    padding: 0.2,
  });

  assert.ok(narrowViewport);
  assert.ok(restoredViewport);
  assert.ok(Math.abs(graphCenterOnScreen(restoredViewport) - 362.5) < 0.001);
  assert.notDeepEqual(restoredViewport, narrowViewport);
});

test('zero-width visible regions do not produce an off-canvas viewport', () => {
  assert.equal(
    calculateVisibleGraphViewport({
      bounds,
      containerWidth: 725,
      containerHeight: 400,
      visibleLeft: 0,
      visibleRight: 0,
      minZoom: 0.45,
      maxZoom: 1.6,
      padding: 0.2,
    }),
    null,
  );
});
