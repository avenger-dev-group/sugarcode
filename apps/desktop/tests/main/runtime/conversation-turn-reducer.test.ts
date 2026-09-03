import assert from 'node:assert/strict';
import test from 'node:test';
import { reduceConversationTurn } from '../../../src/main/runtime/conversation/turns/reducer.ts';
import type { ConversationTurn } from '../../../src/shared/conversation.ts';

const coordinates = {
  requestId: 'request',
  workspaceId: 'workspace',
  threadId: 'thread',
  turnId: 'turn',
};

test('final text is projected literally without natural-language reasoning detection', () => {
  const initial: ConversationTurn = { id: 'turn', status: 'inProgress', messages: [] };
  const text = 'The user wants a summary.\n这是正文，不根据开头猜测或隐藏内容。';
  const streamed = reduceConversationTurn(initial, {
    ...coordinates,
    type: 'turn.textDelta',
    sequence: 1,
    itemId: 'final',
    phase: 'final',
    delta: text,
  });
  assert.ok(streamed);
  assert.equal(streamed.messages[0]?.text, text);
  assert.deepEqual(initial.messages, []);
  assert.equal(streamed.activities, undefined);
  const completed = reduceConversationTurn(streamed, {
    ...coordinates,
    type: 'turn.textCompleted',
    sequence: 2,
    itemId: 'final',
    phase: 'final',
    text,
  });
  assert.equal(completed?.messages[0]?.text, text);
  assert.equal(completed?.messages[0]?.status, 'completed');
  assert.equal(streamed.messages[0]?.status, 'inProgress');
});

test('lifecycle completion is left to the controller', () => {
  assert.equal(reduceConversationTurn(
    { id: 'turn', status: 'inProgress', messages: [] },
    { ...coordinates, type: 'turn.completed', sequence: 1, status: 'completed' },
  ), undefined);
});
