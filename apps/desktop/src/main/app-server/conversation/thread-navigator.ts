import type {
  ConversationThreadNavigatorSnapshot,
} from '@/shared/conversation';

export type MutableThreadNavigator = {
  status: ConversationThreadNavigatorSnapshot['status'];
  activeThreadIds: string[];
  activeTruncated: boolean;
  search: {
    query: string;
    status: ConversationThreadNavigatorSnapshot['search']['status'];
    threadIds: string[];
    truncated: boolean;
    summary?: string;
  };
  pendingThreadId?: string;
  selectionNotice?: string;
};

export const createThreadNavigator = (): MutableThreadNavigator => ({
  status: 'loading',
  activeThreadIds: [],
  activeTruncated: false,
  search: {
    query: '',
    status: 'idle',
    threadIds: [],
    truncated: false,
  },
});

export const snapshotThreadNavigator = (
  navigator: MutableThreadNavigator,
): ConversationThreadNavigatorSnapshot => ({
  status: navigator.status,
  activeThreadIds: [...navigator.activeThreadIds],
  activeTruncated: navigator.activeTruncated,
  search: {
    query: navigator.search.query,
    status: navigator.search.status,
    threadIds: [...navigator.search.threadIds],
    truncated: navigator.search.truncated,
    ...(navigator.search.summary
      ? { summary: navigator.search.summary }
      : {}),
  },
  ...(navigator.pendingThreadId
    ? { pendingThreadId: navigator.pendingThreadId }
    : {}),
  ...(navigator.selectionNotice
    ? { selectionNotice: navigator.selectionNotice }
    : {}),
});

export const isKnownThread = (
  navigator: MutableThreadNavigator,
  currentThreadId: string | null,
  threadId: string,
): boolean =>
  currentThreadId === threadId ||
  navigator.activeThreadIds.includes(threadId) ||
  navigator.search.threadIds.includes(threadId);

export const recordActiveThread = (
  navigator: MutableThreadNavigator,
  threadId: string,
): void => {
  navigator.activeThreadIds = [
    threadId,
    ...navigator.activeThreadIds.filter((id) => id !== threadId),
  ].slice(0, 50);
};
