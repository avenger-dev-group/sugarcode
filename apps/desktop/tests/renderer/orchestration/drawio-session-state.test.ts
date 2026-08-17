import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closeDrawioForSession,
  getSelectedDrawioPath,
  openDrawioForSession,
  type DrawioSessionRegistry,
} from '../../../src/renderer/components/orchestration/drawio-session-state.ts';

test('Draw.io auto-open and selected tab state stay isolated by conversation', () => {
  const registry: DrawioSessionRegistry = new Map();

  assert.equal(
    openDrawioForSession(registry, 'thread-a', 'flow.drawio', true),
    true,
  );
  assert.equal(getSelectedDrawioPath(registry, 'thread-a'), 'flow.drawio');
  assert.equal(getSelectedDrawioPath(registry, 'thread-b'), null);
  assert.equal(
    openDrawioForSession(registry, 'thread-a', 'flow.drawio', true),
    false,
  );

  assert.equal(
    openDrawioForSession(registry, 'thread-b', 'flow.drawio', true),
    true,
  );
  assert.equal(getSelectedDrawioPath(registry, 'thread-b'), 'flow.drawio');
});

test('closing a Draw.io tab prevents automatic reopening but allows explicit reopening', () => {
  const registry: DrawioSessionRegistry = new Map();
  openDrawioForSession(registry, 'thread-a', 'flow.drawio', true);
  closeDrawioForSession(registry, 'thread-a', 'flow.drawio');

  assert.equal(getSelectedDrawioPath(registry, 'thread-a'), null);
  assert.equal(
    openDrawioForSession(registry, 'thread-a', 'flow.drawio', true),
    false,
  );
  assert.equal(
    openDrawioForSession(registry, 'thread-a', 'flow.drawio', false),
    true,
  );
  assert.equal(getSelectedDrawioPath(registry, 'thread-a'), 'flow.drawio');
});
