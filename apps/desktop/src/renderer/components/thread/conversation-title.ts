import type { WorkspaceStateSnapshot } from '@/shared/workspace';

import type {
  ThreadNavigatorViewModel,
  ThreadViewModel,
} from './types';

const NEW_CONVERSATION_TITLE = '新对话';

export const resolveConversationTitle = (
  thread: ThreadViewModel,
  navigator: ThreadNavigatorViewModel,
  workspace: WorkspaceStateSnapshot,
): string | null => {
  const displayedThreadId =
    navigator.pendingThreadId ?? thread.threadIdentity;
  if (!displayedThreadId) {
    return null;
  }

  const projectTitle = workspace.projects
    ?.find((project) => project.threadIds.includes(displayedThreadId))
    ?.threadTitles[displayedThreadId];

  return (
    navigator.threadTitles[displayedThreadId] ??
    projectTitle ??
    workspace.chatTitles?.[displayedThreadId] ??
    NEW_CONVERSATION_TITLE
  );
};
