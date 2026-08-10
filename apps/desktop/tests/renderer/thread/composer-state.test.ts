import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldStartChatOnSend } from '../../../src/renderer/components/thread/composer-state.ts';

test('an unselected workspace starts an independent Chat on first send', () => {
  assert.equal(
    shouldStartChatOnSend({
      revision: 1,
      generation: 0,
      status: 'unselected',
    }),
    true,
  );
  assert.equal(
    shouldStartChatOnSend({
      revision: 2,
      generation: 0,
      status: 'failed',
    }),
    true,
  );
});

test('an active or selecting workspace keeps its existing destination', () => {
  assert.equal(
    shouldStartChatOnSend({
      revision: 1,
      generation: 1,
      status: 'ready',
      kind: 'project',
    }),
    false,
  );
  assert.equal(
    shouldStartChatOnSend({
      revision: 2,
      generation: 2,
      status: 'ready',
      kind: 'chat',
    }),
    false,
  );
  assert.equal(
    shouldStartChatOnSend({
      revision: 3,
      generation: 3,
      status: 'selecting',
      kind: 'chat',
    }),
    false,
  );
});
