import assert from 'node:assert/strict';
import test from 'node:test';
import { reduceConversationTurn } from '../../../src/main/runtime/conversation/turns/reducer.ts';
import type { ConversationTurn } from '../../../src/shared/conversation.ts';
import { projectTurnActivities } from '../../../src/main/runtime/conversation/projection/tool-activities.ts';
import { modelReasoningCommentaryId, reasoningSummaryCommentaryId } from '../../../src/shared/conversation/trusted-commentary.ts';

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

test('reasoning streams independently from the answer and replays without duplication', () => {
  let turn: ConversationTurn = { id: 'turn', status: 'inProgress', messages: [] };
  const reasoningId = modelReasoningCommentaryId('turn', 'item-1');
  const summaryId = reasoningSummaryCommentaryId('turn', 'item-1');
  for (const [index, delta] of ['核对', '数据。'].entries()) {
    turn = reduceConversationTurn(turn, {
      ...coordinates, type: 'turn.textDelta', sequence: index + 1,
      itemId: reasoningId, phase: 'commentary', delta,
    }) ?? turn;
  }
  assert.deepEqual(turn.messages, []);
  assert.deepEqual(turn.activities, [{ type: 'reasoning', activity: { id: reasoningId, text: '核对数据。', status: 'inProgress' } }]);
  const items = [reasoningId, summaryId].map((itemId, index) => ({
    id: itemId, turnId: 'turn', sequence: index + 3, kind: 'turn.textCompleted',
    payload: { itemId, phase: 'commentary' as const, text: index === 0 ? '核对数据。' : '已完成核对。' },
  }));
  for (const item of items) {
    turn = reduceConversationTurn(turn, {
      ...coordinates, ...item.payload, type: 'turn.textCompleted', sequence: item.sequence,
    }) ?? turn;
  }
  assert.deepEqual(turn.activities, projectTurnActivities([...items, ...items]));
  turn = reduceConversationTurn(turn, {
    ...coordinates, type: 'turn.textCompleted', sequence: 5,
    itemId: 'final-answer', phase: 'final', text: '结果：391。',
  }) ?? turn;
  assert.equal(turn.messages[0]?.text, '结果：391。');
  assert.equal(turn.activities?.length, 2);
});
