import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isTrustedCommentaryId,
  toolProgressCommentaryId,
} from '../../src/shared/conversation/trusted-commentary.ts';

test('only Runtime-authored tool progress uses the trusted commentary namespace', () => {
  const id = toolProgressCommentaryId('turn-1', 'call-1');

  assert.equal(id, 'turn-1:progress:call-1');
  assert.equal(isTrustedCommentaryId('turn-1', id), true);
  assert.equal(isTrustedCommentaryId('turn-1', 'provider-commentary'), false);
  assert.equal(isTrustedCommentaryId('turn-2', id), false);
});
