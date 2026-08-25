import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closeDrawioForSession,
  getSelectedDrawioPath,
  openDrawioForSession,
  type DrawioSessionRegistry,
} from '../../../src/renderer/components/orchestration/drawio-session-state.ts';

test('Draw.io selection stays isolated by conversation', () => {
  const registry: DrawioSessionRegistry = new Map();

  openDrawioForSession(registry, 'thread-a', 'flow.drawio');
  assert.equal(getSelectedDrawioPath(registry, 'thread-a'), 'flow.drawio');
  assert.equal(getSelectedDrawioPath(registry, 'thread-b'), null);

  openDrawioForSession(registry, 'thread-b', 'flow.drawio');
  assert.equal(getSelectedDrawioPath(registry, 'thread-b'), 'flow.drawio');
});

test('closing and explicitly reopening a Draw.io tab updates its conversation', () => {
  const registry: DrawioSessionRegistry = new Map();
  openDrawioForSession(registry, 'thread-a', 'flow.drawio');
  closeDrawioForSession(registry, 'thread-a', 'flow.drawio');

  assert.equal(getSelectedDrawioPath(registry, 'thread-a'), null);
  openDrawioForSession(registry, 'thread-a', 'flow.drawio');
  assert.equal(getSelectedDrawioPath(registry, 'thread-a'), 'flow.drawio');
});
