import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isDrawioEdgeLinePath,
  isDrawioFlowAnimationValue,
  resolveDrawioFlowAnimation,
} from '../../src/renderer/components/workspace/drawio/drawio-animation.ts';

test('Draw.io animation recognizes maxGraph stroke paths without an explicit fill', () => {
  assert.equal(
    isDrawioEdgeLinePath({
      data: 'M 20 20 L 80 20',
      fill: null,
      stroke: '#374151',
      visibility: null,
    }),
    true,
  );
  assert.equal(
    isDrawioEdgeLinePath({
      data: 'M 80 16 L 88 20 L 80 24 Z',
      fill: '#374151',
      stroke: '#374151',
      visibility: null,
    }),
    false,
  );
  assert.equal(
    isDrawioEdgeLinePath({
      data: 'M 20 20 L 80 20',
      fill: 'none',
      stroke: 'white',
      visibility: 'hidden',
    }),
    false,
  );
});

test('Draw.io animation enables only explicitly marked flow edges', () => {
  assert.equal(isDrawioFlowAnimationValue(1), true);
  assert.equal(isDrawioFlowAnimationValue('1'), true);
  assert.equal(isDrawioFlowAnimationValue(true), true);
  assert.equal(isDrawioFlowAnimationValue(undefined), false);
  assert.equal(isDrawioFlowAnimationValue(0), false);
});

test('Draw.io animation follows official dash duration and direction semantics', () => {
  assert.deepEqual(
    resolveDrawioFlowAnimation({
      existingDashArray: null,
      scale: 1.25,
      style: {
        flowAnimationDirection: 'reverse',
        flowAnimationDuration: 800,
        flowAnimationTimingFunction: 'ease-in-out',
      },
    }),
    {
      dashArray: '10',
      direction: 'reverse',
      durationMs: 800,
      offset: 20,
      timing: 'ease-in-out',
    },
  );
});
