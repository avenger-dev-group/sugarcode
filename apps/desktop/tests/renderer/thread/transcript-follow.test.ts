import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isTranscriptScrollUpKey,
  shouldFollowProcessAfterScroll,
  shouldFollowTranscriptAfterScroll,
  shouldHandoffWheelScroll,
  shouldHoldTranscriptPlaceholder,
  shouldResetTranscriptFollow,
  shouldTrackTranscriptPointerScroll,
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

test('mouse clicks in transcript content are not treated as scrollbar drags', () => {
  assert.equal(
    shouldTrackTranscriptPointerScroll({
      pointerType: 'mouse',
      targetIsScrollbar: false,
    }),
    false,
  );
  assert.equal(
    shouldTrackTranscriptPointerScroll({
      pointerType: 'mouse',
      targetIsScrollbar: true,
    }),
    true,
  );
});

test('touch gestures remain explicit transcript scroll intent', () => {
  assert.equal(
    shouldTrackTranscriptPointerScroll({
      pointerType: 'touch',
      targetIsScrollbar: false,
    }),
    true,
  );
});

test('nested process scrolling hands downward wheel input to the transcript at its bottom edge', () => {
  assert.equal(
    shouldHandoffWheelScroll({
      deltaY: 24,
      scrollTop: 400,
      scrollHeight: 800,
      clientHeight: 400,
    }),
    true,
  );
  assert.equal(
    shouldHandoffWheelScroll({
      deltaY: 24,
      scrollTop: 300,
      scrollHeight: 800,
      clientHeight: 400,
    }),
    false,
  );
});

test('nested process scrolling hands upward wheel input to the transcript at its top edge', () => {
  assert.equal(
    shouldHandoffWheelScroll({
      deltaY: -24,
      scrollTop: 0,
      scrollHeight: 800,
      clientHeight: 400,
    }),
    true,
  );
  assert.equal(
    shouldHandoffWheelScroll({
      deltaY: -24,
      scrollTop: 40,
      scrollHeight: 800,
      clientHeight: 400,
    }),
    false,
  );
});

test('streaming process content follows only while its viewport remains near the bottom', () => {
  assert.equal(
    shouldFollowProcessAfterScroll({
      scrollTop: 376,
      scrollHeight: 800,
      clientHeight: 400,
    }),
    true,
  );
  assert.equal(
    shouldFollowProcessAfterScroll({
      scrollTop: 300,
      scrollHeight: 800,
      clientHeight: 400,
    }),
    false,
  );
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

test('completed selection holds its placeholder until deferred content is ready', () => {
  assert.equal(
    shouldHoldTranscriptPlaceholder({
      deferredThreadId: 'thread-a',
      pendingThreadId: null,
      previousPendingThreadId: 'thread-b',
      threadId: 'thread-b',
    }),
    true,
  );
  assert.equal(
    shouldHoldTranscriptPlaceholder({
      deferredThreadId: 'thread-b',
      pendingThreadId: null,
      previousPendingThreadId: 'thread-b',
      threadId: 'thread-b',
    }),
    false,
  );
});

test('new Threads render immediately without a selection placeholder', () => {
  assert.equal(
    shouldHoldTranscriptPlaceholder({
      deferredThreadId: null,
      pendingThreadId: null,
      previousPendingThreadId: null,
      threadId: 'thread-new',
    }),
    false,
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
