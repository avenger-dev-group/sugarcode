import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_LAYOUT,
  parseStoredLayout,
  resolveContextRailOpen,
  updateContextRailVisibility,
} from '../../../src/renderer/components/foundation/layout-state.ts';

test('a fresh installation starts with the context rail closed', () => {
  assert.deepEqual(parseStoredLayout(null), DEFAULT_LAYOUT);
  assert.equal(parseStoredLayout(null).navigatorOpen, true);
  assert.equal(parseStoredLayout(null).contextRailOpen, false);
});

test('saved panel visibility is restored on later launches', () => {
  const layout = parseStoredLayout(
    JSON.stringify({
      navigatorWidth: 320,
      navigatorOpen: false,
      contextRailWidth: 680,
      contextRailOpen: true,
    }),
  );

  assert.deepEqual(layout, {
    navigatorWidth: 320,
    navigatorOpen: false,
    contextRailWidth: 680,
    contextRailOpen: true,
  });
});

test('context rail visibility follows each conversation independently', () => {
  let visibility = new Map<string, boolean>();
  visibility = new Map(
    updateContextRailVisibility(visibility, 'thread-a', true),
  );

  assert.equal(resolveContextRailOpen(visibility, 'thread-a', false), true);
  assert.equal(resolveContextRailOpen(visibility, 'thread-b', true), false);

  visibility = new Map(
    updateContextRailVisibility(visibility, 'thread-b', true),
  );
  visibility = new Map(
    updateContextRailVisibility(visibility, 'thread-a', false),
  );

  assert.equal(resolveContextRailOpen(visibility, 'thread-a', true), false);
  assert.equal(resolveContextRailOpen(visibility, 'thread-b', false), true);
});
