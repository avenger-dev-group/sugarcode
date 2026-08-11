import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_LAYOUT,
  parseStoredLayout,
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
