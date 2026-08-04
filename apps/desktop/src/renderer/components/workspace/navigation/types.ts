import type { WorkspaceStateSnapshot } from '@/shared/workspace';

export type WorkspaceNavigationStore = Readonly<{
  state: WorkspaceStateSnapshot;
  busy: boolean;
  error: string | null;
  failedChatThreadId: string | null;
  chooseProject: () => Promise<boolean>;
  resumeProject: () => Promise<boolean>;
  activateProject: (projectId: string) => Promise<boolean>;
  focusTask: (threadId: string) => Promise<boolean>;
  activateChat: (threadId?: string) => Promise<boolean>;
  deleteFailedChat: (threadId: string) => Promise<boolean>;
}>;
