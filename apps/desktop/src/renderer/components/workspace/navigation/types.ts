import type { WorkspaceStateSnapshot } from '@/shared/workspace';

export type WorkspaceNavigationStore = Readonly<{
  state: WorkspaceStateSnapshot;
  busy: boolean;
  error: string | null;
  chooseProject: () => Promise<boolean>;
  resumeProject: () => Promise<boolean>;
  activateChat: (threadId?: string) => Promise<boolean>;
}>;
