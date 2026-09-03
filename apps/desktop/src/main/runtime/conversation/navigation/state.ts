import type { ConversationThreadNavigatorSnapshot } from '../../../../shared/conversation.ts';

export const emptyNavigator = (): ConversationThreadNavigatorSnapshot => ({
  status: 'unavailable',
  activeThreadIds: [],
  activeThreadTitles: {},
  activeTruncated: false,
  runningThreadIds: [],
  inputRequiredThreadIds: [],
  search: {
    query: '',
    status: 'idle',
    threadIds: [],
    threadTitles: {},
    truncated: false,
  },
});

type ClearableNavigatorField =
  | 'pendingThreadId'
  | 'pendingMutation'
  | 'selectionNotice'
  | 'mutationNotice'
  | 'unreadThreadStatuses';

export const withoutNavigatorFields = (
  navigator: ConversationThreadNavigatorSnapshot,
  fields: readonly ClearableNavigatorField[],
): ConversationThreadNavigatorSnapshot => {
  const next = { ...navigator };
  for (const field of fields) {
    delete next[field];
  }
  return next;
};
