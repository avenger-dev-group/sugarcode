import type {
  ConversationThreadNavigatorSnapshot,
} from '@/shared/conversation';

export type MutableThreadNavigator = {
  status: ConversationThreadNavigatorSnapshot['status'];
  activeThreadIds: string[];
  activeThreadTitles: Record<string, string>;
  activeTruncated: boolean;
  search: {
    query: string;
    status: ConversationThreadNavigatorSnapshot['search']['status'];
    threadIds: string[];
    threadTitles: Record<string, string>;
    truncated: boolean;
    summary?: string;
  };
  pendingThreadId?: string;
  pendingMutation?: {
    kind: 'fork' | 'archive' | 'unarchive' | 'delete';
    threadId: string;
  };
  archivedUndoThreadId?: string;
  selectionNotice?: string;
  mutationNotice?: string;
};

export const createThreadNavigator = (): MutableThreadNavigator => ({
  status: 'loading',
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
});

export const snapshotThreadNavigator = (
  navigator: MutableThreadNavigator,
): ConversationThreadNavigatorSnapshot => ({
  status: navigator.status,
  activeThreadIds: [...navigator.activeThreadIds],
  activeThreadTitles: { ...navigator.activeThreadTitles },
  activeTruncated: navigator.activeTruncated,
  search: {
    query: navigator.search.query,
    status: navigator.search.status,
    threadIds: [...navigator.search.threadIds],
    threadTitles: { ...navigator.search.threadTitles },
    truncated: navigator.search.truncated,
    ...(navigator.search.summary
      ? { summary: navigator.search.summary }
      : {}),
  },
  ...(navigator.pendingThreadId
    ? { pendingThreadId: navigator.pendingThreadId }
    : {}),
  ...(navigator.pendingMutation
    ? { pendingMutation: { ...navigator.pendingMutation } }
    : {}),
  ...(navigator.archivedUndoThreadId
    ? { archivedUndoThreadId: navigator.archivedUndoThreadId }
    : {}),
  ...(navigator.selectionNotice
    ? { selectionNotice: navigator.selectionNotice }
    : {}),
  ...(navigator.mutationNotice
    ? { mutationNotice: navigator.mutationNotice }
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
  title?: string,
): void => {
  navigator.activeThreadIds = [
    threadId,
    ...navigator.activeThreadIds.filter((id) => id !== threadId),
  ].slice(0, 50);
  if (title) {
    navigator.activeThreadTitles[threadId] = title;
  }
  navigator.activeThreadTitles = Object.fromEntries(
    navigator.activeThreadIds.flatMap((id) => {
      const activeTitle = navigator.activeThreadTitles[id];
      return activeTitle ? [[id, activeTitle]] : [];
    }),
  );
};

export const resetThreadSearch = (
  navigator: MutableThreadNavigator,
): void => {
  navigator.search = {
    query: '',
    status: 'idle',
    threadIds: [],
    threadTitles: {},
    truncated: false,
  };
};
