import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptConversationSnapshot,
  acceptConversationThreadDelta,
  acceptConversationThreadProjection,
  acceptForegroundCommit,
  beginConversationSelection,
  conversationProjectionStore,
  failConversationSelection,
} from '../../../src/renderer/stores/conversation-projection-store.ts';
import type {
  ConversationStateSnapshot,
  ConversationThreadProjectionSnapshot,
  ConversationTurn,
} from '../../../src/shared/conversation.ts';

const snapshot = (
  revision: number,
  threadId: string,
): ConversationStateSnapshot => ({
  revision,
  workspaceId: 'workspace-fixture',
  phase: 'ready',
  threadId,
  turns: [],
  navigator: {
    status: 'ready',
    activeThreadIds: ['thread-a', 'thread-b'],
    activeThreadTitles: {
      'thread-a': 'Thread A',
      'thread-b': 'Thread B',
    },
    activeTruncated: false,
    search: {
      query: '',
      status: 'idle',
      threadIds: [],
      threadTitles: {},
      truncated: false,
    },
  },
});

const projection = (
  threadId: string,
  revision: number,
  turns: readonly ConversationTurn[] = [],
): ConversationThreadProjectionSnapshot => ({
  revision,
  workspaceId: 'workspace-fixture',
  threadId,
  phase: 'ready',
  turns,
});

test('thread projection store isolates background deltas and detects gaps', () => {
  conversationProjectionStore.setState({
    snapshot: snapshot(1, 'thread-a'),
    snapshotsByThread: new Map(),
    sourceRevision: 1,
    loadError: null,
    selectionGeneration: 0,
  });
  acceptConversationThreadProjection(projection('thread-a', 1));
  acceptConversationThreadProjection(projection('thread-b', 4));

  const selectedBefore = conversationProjectionStore.getState().snapshot;
  const backgroundTurn: ConversationTurn = {
    id: 'turn-b',
    status: 'completed',
    messages: [],
  };
  assert.equal(
    acceptConversationThreadDelta({
      revision: 5,
      workspaceId: 'workspace-fixture',
      threadId: 'thread-b',
      phase: 'ready',
      turn: backgroundTurn,
    }),
    'accepted',
  );
  assert.equal(
    conversationProjectionStore.getState().snapshot,
    selectedBefore,
  );
  assert.equal(
    conversationProjectionStore
      .getState()
      .snapshotsByThread.get('thread-b')
      ?.turns[0]?.id,
    'turn-b',
  );

  assert.equal(
    acceptConversationThreadDelta({
      revision: 7,
      workspaceId: 'workspace-fixture',
      threadId: 'thread-b',
      phase: 'ready',
      turn: backgroundTurn,
    }),
    'gap',
  );
  assert.equal(
    conversationProjectionStore
      .getState()
      .snapshotsByThread.get('thread-b')
      ?.revision,
    5,
  );
});

test('thread projection store ignores duplicate full projection revisions', () => {
  conversationProjectionStore.setState({
    snapshot: snapshot(1, 'thread-a'),
    snapshotsByThread: new Map(),
    sourceRevision: 1,
    loadError: null,
    selectionGeneration: 0,
  });
  const notifications: number[] = [];
  const unsubscribe = conversationProjectionStore.subscribe((state) => {
    notifications.push(state.snapshotsByThread.get('thread-a')?.revision ?? -1);
  });

  acceptConversationThreadProjection(projection('thread-a', 1));
  const acceptedState = conversationProjectionStore.getState();
  acceptConversationThreadProjection(projection('thread-a', 1));
  unsubscribe();

  assert.equal(conversationProjectionStore.getState(), acceptedState);
  assert.deepEqual(notifications, [1]);
});

test('conversation selection overlay never exposes the previous transcript', () => {
  acceptConversationSnapshot(snapshot(2, 'thread-a'));
  beginConversationSelection('thread-b');
  assert.equal(
    conversationProjectionStore.getState().snapshot.navigator.pendingThreadId,
    'thread-b',
  );
  assert.equal(
    conversationProjectionStore.getState().snapshot.navigator.selectionNotice,
    undefined,
  );

  acceptConversationSnapshot(snapshot(3, 'thread-a'));
  assert.equal(
    conversationProjectionStore.getState().snapshot.navigator.pendingThreadId,
    'thread-b',
  );

  failConversationSelection('thread-b', 'Load failed.');
  assert.equal(
    conversationProjectionStore.getState().snapshot.navigator.pendingThreadId,
    'thread-b',
  );
  assert.equal(
    conversationProjectionStore.getState().snapshot.navigator.selectionNotice,
    'Load failed.',
  );
});

test('an authoritative target snapshot completes a Chat selection overlay', () => {
  conversationProjectionStore.setState({
    snapshot: snapshot(1, 'thread-a'),
    snapshotsByThread: new Map(),
    sourceRevision: 1,
    loadError: null,
    selectionGeneration: 0,
  });
  beginConversationSelection('thread-b');

  acceptConversationSnapshot(snapshot(2, 'thread-b'));

  assert.equal(
    conversationProjectionStore.getState().snapshot.navigator.pendingThreadId,
    undefined,
  );
  assert.equal(
    conversationProjectionStore.getState().snapshot.threadId,
    'thread-b',
  );
});

test('foreground commits are latest-wins across Workspace and Thread results', () => {
  const workspace = {
    revision: 3,
    generation: 1,
    status: 'ready' as const,
    kind: 'project' as const,
    name: 'Fixture',
  };
  acceptForegroundCommit({
    selection: {
      generation: 2,
      workspaceId: 'workspace-fixture',
      threadId: 'thread-b',
    },
    workspace,
    thread: projection('thread-b', 5),
  });
  acceptForegroundCommit({
    selection: {
      generation: 1,
      workspaceId: 'workspace-fixture',
      threadId: 'thread-a',
    },
    workspace,
    thread: projection('thread-a', 2),
  });
  assert.equal(
    conversationProjectionStore.getState().snapshot.threadId,
    'thread-b',
  );
  assert.equal(
    conversationProjectionStore.getState().selectionGeneration,
    2,
  );
});
