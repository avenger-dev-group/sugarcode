import assert from 'node:assert/strict';
import test from 'node:test';

import { isConversationStateSnapshot } from '../../src/shared/conversation.ts';

const THREAD_WEB = '00000000-0001-7000-8000-000000000001';
const THREAD_ADMIN = '00000000-0001-7000-8000-000000000002';

const snapshot = (unreadStatus: string) => ({
  revision: 1,
  phase: 'idle',
  turns: [] as const,
  navigator: {
    status: 'ready',
    activeThreadIds: [] as const,
    activeThreadTitles: {},
    activeTruncated: false,
    runningThreadIds: [THREAD_WEB],
    unreadThreadStatuses: {
      [THREAD_ADMIN]: unreadStatus,
    },
    search: {
      query: '',
      status: 'idle',
      threadIds: [] as const,
      threadTitles: {},
      truncated: false,
    },
  },
});

test('conversation snapshots accept global navigation statuses outside the foreground workspace', () => {
  assert.equal(isConversationStateSnapshot(snapshot('completed')), true);
  assert.equal(isConversationStateSnapshot(snapshot('failed')), true);
  assert.equal(isConversationStateSnapshot(snapshot('interrupted')), true);
});

test('conversation snapshots reject non-terminal unread states', () => {
  assert.equal(isConversationStateSnapshot(snapshot('inProgress')), false);
});

test('reload-required navigation accepts unique UUIDv7 Thread IDs', () => {
  assert.equal(
    isConversationStateSnapshot({
      ...snapshot('completed'),
      navigator: {
        ...snapshot('completed').navigator,
        reloadRequiredThreadIds: [THREAD_WEB, THREAD_ADMIN],
      },
    }),
    true,
  );
});

test('reload-required navigation rejects duplicate or invalid Thread IDs', () => {
  for (const reloadRequiredThreadIds of [
    [THREAD_WEB, THREAD_WEB],
    ['thread-web'],
  ]) {
    assert.equal(
      isConversationStateSnapshot({
        ...snapshot('completed'),
        navigator: {
          ...snapshot('completed').navigator,
          reloadRequiredThreadIds,
        },
      }),
      false,
    );
  }
});
