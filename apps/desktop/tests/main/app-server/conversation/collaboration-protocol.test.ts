import assert from 'node:assert/strict';
import test from 'node:test';

import { isHiddenCollaborationItem } from '../../../../src/main/app-server/conversation/collaboration-protocol.ts';

const ITEM_ID = '00000000-0002-7000-8000-000000000003';

test('internal collaboration tool lifecycle is recognized as hidden', () => {
  for (const name of [
    'collaboration/dispatch',
    'collaboration/amend',
    'collaboration/wait',
    'collaboration/interrupt',
  ]) {
    assert.equal(
      isHiddenCollaborationItem({
        type: 'toolCall',
        id: ITEM_ID,
        callId: 'call-collaboration',
        name,
        arguments: {},
      }),
      true,
    );
    assert.equal(
      isHiddenCollaborationItem({
        type: 'toolResult',
        id: ITEM_ID,
        callId: 'call-collaboration',
        name,
        result: { type: 'success', content: '{}', bytes: 2 },
      }),
      true,
    );
  }
  assert.equal(
    isHiddenCollaborationItem({
      type: 'toolResult',
      id: ITEM_ID,
      callId: 'call-collaboration',
      name: 'collaboration/wait',
      result: { type: 'error', kind: 'taskFailed' },
    }),
    true,
  );
});

test('unknown and malformed tool lifecycle is not hidden', () => {
  assert.equal(
    isHiddenCollaborationItem({
      type: 'toolCall',
      id: ITEM_ID,
      callId: 'call-unknown',
      name: 'unknown/tool',
      arguments: {},
    }),
    false,
  );
  assert.equal(
    isHiddenCollaborationItem({
      type: 'toolResult',
      id: ITEM_ID,
      callId: 'call-collaboration',
      name: 'collaboration/wait',
      result: { type: 'success', content: '{}', bytes: 3 },
    }),
    false,
  );
  assert.equal(
    isHiddenCollaborationItem({
      type: 'toolCall',
      id: ITEM_ID,
      callId: 'call-collaboration',
      name: 'collaboration/dispatch',
      arguments: [],
    }),
    false,
  );
  assert.equal(
    isHiddenCollaborationItem({
      type: 'toolCall',
      id: ITEM_ID,
      callId: 'call-collaboration',
      name: 'collaboration/dispatch',
      arguments: {},
      unexpected: true,
    }),
    false,
  );
});
