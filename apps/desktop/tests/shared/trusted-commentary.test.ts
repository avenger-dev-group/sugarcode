import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isTrustedCommentaryId,
  commentaryActivityType,
  modelReasoningCommentaryId,
  reasoningSummaryCommentaryId,
  modelProgressCommentaryId,
  toolProgressCommentaryId,
} from '../../src/shared/conversation/trusted-commentary.ts';

test('Runtime-authored tool and public model progress use trusted commentary namespaces', () => {
  const id = toolProgressCommentaryId('turn-1', 'call-1');
  const modelId = modelProgressCommentaryId('turn-1', 'message-1');

  assert.equal(id, 'turn-1:progress:call-1');
  assert.equal(modelId, 'turn-1:model-progress:message-1');
  assert.equal(isTrustedCommentaryId('turn-1', id), true);
  assert.equal(isTrustedCommentaryId('turn-1', modelId), true);
  assert.equal(isTrustedCommentaryId('turn-1', 'provider-commentary'), false);
  assert.equal(isTrustedCommentaryId('turn-2', id), false);
  assert.equal(isTrustedCommentaryId('turn-2', modelId), false);
});

test('provider reasoning and summaries have disjoint, turn-scoped identities', () => {
  const reasoning = modelReasoningCommentaryId('turn-1', 'same-provider-item');
  const summary = reasoningSummaryCommentaryId('turn-1', 'same-provider-item');
  assert.notEqual(reasoning, summary);
  assert.equal(isTrustedCommentaryId('turn-1', reasoning), true);
  assert.equal(isTrustedCommentaryId('turn-2', reasoning), false);
  assert.equal(commentaryActivityType('turn-1', reasoning), 'reasoning');
  assert.equal(commentaryActivityType('turn-1', summary), 'reasoningSummary');
});
