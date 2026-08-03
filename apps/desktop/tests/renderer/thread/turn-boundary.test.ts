import assert from 'node:assert/strict';
import test from 'node:test';

import { toTranscriptTurnBoundary } from '../../../src/renderer/components/thread/turn-boundary.ts';

test('the first Turn has no leading boundary', () => {
  assert.equal(toTranscriptTurnBoundary(0, false), 'none');
});

test('a follow-up Turn gets a divider after a normal completion', () => {
  assert.equal(toTranscriptTurnBoundary(1, false), 'divider');
});

test('a visible terminal line serves as the follow-up Turn boundary', () => {
  assert.equal(
    toTranscriptTurnBoundary(1, true),
    'precedingTerminal',
  );
});
