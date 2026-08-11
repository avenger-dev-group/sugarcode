import { createStore } from 'zustand/vanilla';

import type {
  ConversationStateSnapshot,
  ConversationThreadProjectionDelta,
  ConversationThreadProjectionSnapshot,
} from '@/shared/conversation';
import type { ForegroundCommit } from '@/shared/workspace';

const INITIAL_SNAPSHOT: ConversationStateSnapshot = {
  revision: 0,
  phase: 'unavailable',
  turns: [],
  navigator: {
    status: 'unavailable',
    activeThreadIds: [],
    activeThreadTitles: {},
    activeTruncated: false,
    search: {
      query: '',
      status: 'idle',
      threadIds: [],
      threadTitles: {},
      truncated: false,
    },
  },
};

type ConversationProjectionState = Readonly<{
  snapshot: ConversationStateSnapshot;
  snapshotsByThread: ReadonlyMap<string, ConversationThreadProjectionSnapshot>;
  sourceRevision: number;
  loadError: string | null;
  selectionGeneration: number;
}>;

export const conversationProjectionStore =
  createStore<ConversationProjectionState>()(() => ({
    snapshot: INITIAL_SNAPSHOT,
    snapshotsByThread: new Map(),
    sourceRevision: -1,
    loadError: null,
    selectionGeneration: 0,
  }));

export const acceptConversationSnapshot = (
  snapshot: ConversationStateSnapshot,
): void => {
  const current = conversationProjectionStore.getState();
  if (snapshot.revision <= current.sourceRevision) {
    return;
  }
  const pendingThreadId = current.snapshot.navigator.pendingThreadId;
  const selectionNotice = current.snapshot.navigator.selectionNotice;
  const selectionCommittedBySnapshot =
    pendingThreadId !== undefined &&
    snapshot.threadId === pendingThreadId &&
    snapshot.navigator.pendingThreadId === undefined &&
    snapshot.navigator.selectionNotice === undefined;
  const navigator = pendingThreadId && !selectionCommittedBySnapshot
    ? {
        ...snapshot.navigator,
        pendingThreadId,
        ...(selectionNotice ? { selectionNotice } : {}),
      }
    : snapshot.navigator;
  conversationProjectionStore.setState({
    snapshot: navigator === snapshot.navigator
      ? snapshot
      : { ...snapshot, navigator },
    sourceRevision: snapshot.revision,
    loadError: null,
  });
};

export const acceptConversationThreadProjection = (
  projection: ConversationThreadProjectionSnapshot,
): void => {
  const current = conversationProjectionStore.getState();
  const previous = current.snapshotsByThread.get(projection.threadId);
  if (previous && projection.revision < previous.revision) {
    return;
  }
  const snapshotsByThread = new Map(current.snapshotsByThread);
  snapshotsByThread.set(projection.threadId, projection);
  const selected = current.snapshot.threadId === projection.threadId;
  const snapshotWithoutActiveTurn = { ...current.snapshot };
  delete snapshotWithoutActiveTurn.activeTurnId;
  conversationProjectionStore.setState({
    snapshotsByThread,
    ...(selected
      ? {
          snapshot: {
            ...snapshotWithoutActiveTurn,
            workspaceId: projection.workspaceId,
            phase: projection.phase,
            threadId: projection.threadId,
            ...(projection.activeTurnId
              ? { activeTurnId: projection.activeTurnId }
              : {}),
            turns: projection.turns,
          },
        }
      : {}),
    loadError: null,
  });
};

export const acceptConversationThreadDelta = (
  delta: ConversationThreadProjectionDelta,
): 'accepted' | 'gap' | 'ignored' => {
  const current = conversationProjectionStore.getState();
  const previous = current.snapshotsByThread.get(delta.threadId);
  if (!previous) {
    return 'ignored';
  }
  if (delta.revision <= previous.revision) {
    return 'ignored';
  }
  if (delta.revision !== previous.revision + 1) {
    return 'gap';
  }
  const turnIndex = previous.turns.findIndex(
    (turn) => turn.id === delta.turn.id,
  );
  const turns = [...previous.turns];
  if (turnIndex >= 0) {
    turns[turnIndex] = delta.turn;
  } else {
    turns.push(delta.turn);
  }
  const projection: ConversationThreadProjectionSnapshot = {
    revision: delta.revision,
    workspaceId: delta.workspaceId,
    threadId: delta.threadId,
    phase: delta.phase,
    ...(delta.activeTurnId ? { activeTurnId: delta.activeTurnId } : {}),
    turns,
  };
  acceptConversationThreadProjection(projection);
  return 'accepted';
};

export const acceptForegroundCommit = (commit: ForegroundCommit): void => {
  const current = conversationProjectionStore.getState();
  if (commit.selection.generation < current.selectionGeneration) {
    return;
  }
  const navigator = { ...current.snapshot.navigator };
  delete navigator.pendingThreadId;
  delete navigator.selectionNotice;
  const snapshotsByThread = new Map(current.snapshotsByThread);
  if (commit.thread) {
    snapshotsByThread.set(commit.thread.threadId, commit.thread);
  }
  const base = {
    ...current.snapshot,
    workspaceId: commit.selection.workspaceId,
    navigator,
  };
  delete base.threadId;
  delete base.activeTurnId;
  conversationProjectionStore.setState({
    snapshot: commit.thread
      ? {
          ...base,
          phase: commit.thread.phase,
          threadId: commit.thread.threadId,
          ...(commit.thread.activeTurnId
            ? { activeTurnId: commit.thread.activeTurnId }
            : {}),
          turns: commit.thread.turns,
        }
      : { ...base, phase: 'idle', turns: [] },
    snapshotsByThread,
    selectionGeneration: commit.selection.generation,
    loadError: null,
  });
};

export const beginConversationSelection = (threadId: string): void => {
  const current = conversationProjectionStore.getState();
  const navigator = { ...current.snapshot.navigator };
  delete navigator.selectionNotice;
  conversationProjectionStore.setState({
    snapshot: {
      ...current.snapshot,
      navigator: { ...navigator, pendingThreadId: threadId },
    },
    loadError: null,
  });
};

export const failConversationSelection = (
  threadId: string,
  summary: string,
): void => {
  const current = conversationProjectionStore.getState();
  conversationProjectionStore.setState({
    snapshot: {
      ...current.snapshot,
      navigator: {
        ...current.snapshot.navigator,
        pendingThreadId: threadId,
        selectionNotice: summary,
      },
    },
    loadError: null,
  });
};

export const reportConversationProjectionError = (message: string): void => {
  conversationProjectionStore.setState({ loadError: message });
};
