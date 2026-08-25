import assert from 'node:assert/strict';
import test from 'node:test';

import { hasRemainingContextTabs } from '../../../src/renderer/components/orchestration/context-tab-state.ts';

test('closing the only context tab leaves no remaining tabs', () => {
  assert.equal(
    hasRemainingContextTabs(
      {
        files: false,
        browserCount: 0,
        resource: true,
        plan: false,
        agent: false,
      },
      'resource',
    ),
    false,
  );
});

test('closing one tab keeps the context rail when another tab remains', () => {
  assert.equal(
    hasRemainingContextTabs(
      {
        files: true,
        browserCount: 0,
        resource: true,
        plan: false,
        agent: false,
      },
      'resource',
    ),
    true,
  );
  assert.equal(
    hasRemainingContextTabs(
      {
        files: false,
        browserCount: 2,
        resource: false,
        plan: false,
        agent: false,
      },
      'browser',
    ),
    true,
  );
});
