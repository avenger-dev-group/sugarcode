import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isTranscriptScrollUpKey,
  shouldFollowTranscriptAfterScroll,
  shouldResetTranscriptFollow,
} from '../../../src/renderer/components/thread/transcript-follow.ts';

test('layout shrink preserves tail following when scrollTop is clamped upward', () => {
  assert.equal(
    shouldFollowTranscriptAfterScroll({
      wasFollowing: true,
      previousScrollTop: 900,
      scrollTop: 120,
      scrollHeight: 1_200,
      clientHeight: 600,
      pointerScrollActive: false,
    }),
    true,
  );
});

test('pointer-driven upward scrolling disables tail following away from the bottom', () => {
  assert.equal(
    shouldFollowTranscriptAfterScroll({
      wasFollowing: true,
      previousScrollTop: 900,
      scrollTop: 700,
      scrollHeight: 1_600,
      clientHeight: 600,
      pointerScrollActive: true,
    }),
    false,
  );
});

test('returning near the bottom resumes tail following', () => {
  assert.equal(
    shouldFollowTranscriptAfterScroll({
      wasFollowing: false,
      previousScrollTop: 400,
      scrollTop: 960,
      scrollHeight: 1_600,
      clientHeight: 600,
      pointerScrollActive: false,
    }),
    true,
  );
});

test('keyboard scroll-up intent covers transcript navigation keys', () => {
  assert.equal(isTranscriptScrollUpKey('ArrowUp', false), true);
  assert.equal(isTranscriptScrollUpKey('PageUp', false), true);
  assert.equal(isTranscriptScrollUpKey('Home', false), true);
  assert.equal(isTranscriptScrollUpKey(' ', true), true);
  assert.equal(isTranscriptScrollUpKey('PageDown', false), false);
  assert.equal(isTranscriptScrollUpKey(' ', false), false);
});

test('completed selection resets transcript following for the selected Thread', () => {
  assert.equal(
    shouldResetTranscriptFollow({
      previousThreadId: 'thread-a',
      threadId: 'thread-b',
      previousPendingThreadId: 'thread-b',
      pendingThreadId: null,
      userMessageAdded: false,
    }),
    true,
  );
});

test('failed selection keeps the current transcript follow preference', () => {
  assert.equal(
    shouldResetTranscriptFollow({
      previousThreadId: 'thread-a',
      threadId: 'thread-a',
      previousPendingThreadId: 'thread-b',
      pendingThreadId: 'thread-b',
      userMessageAdded: false,
    }),
    false,
  );
});
