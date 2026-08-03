import type {
  WorkspaceInspectRequest,
  WorkspaceInspectResult,
  WorkspaceListRequest,
  WorkspaceListResult,
  WorkspaceSelectResult,
  WorkspaceStateSnapshot,
} from '@/shared/workspace';

export const getWorkspaceState = (): Promise<WorkspaceStateSnapshot> =>
  window.sugarcode.getWorkspaceState();

export const onWorkspaceStateChanged = (
  listener: (snapshot: WorkspaceStateSnapshot) => void,
): (() => void) => window.sugarcode.onWorkspaceStateChanged(listener);

export const selectWorkspace = (): Promise<WorkspaceSelectResult> =>
  window.sugarcode.selectWorkspace();

export const resumeWorkspaceProject =
  (): Promise<WorkspaceSelectResult> =>
    window.sugarcode.resumeWorkspaceProject();

export const activateWorkspaceProject = (
  projectId: string,
): Promise<WorkspaceSelectResult> =>
  window.sugarcode.activateWorkspaceProject(projectId);

export const focusWorkspaceTask = (
  threadId: string,
): Promise<WorkspaceSelectResult> =>
  window.sugarcode.focusWorkspaceTask(threadId);

export const activateWorkspaceChat = (
  threadId?: string,
): Promise<WorkspaceSelectResult> =>
  window.sugarcode.activateWorkspaceChat(
    threadId ? { threadId } : {},
  );

export const clearWorkspace = (): Promise<WorkspaceSelectResult> =>
  window.sugarcode.clearWorkspace();

export const listWorkspace = (
  request: WorkspaceListRequest,
): Promise<WorkspaceListResult> =>
  window.sugarcode.listWorkspace(request);

export const inspectWorkspace = (
  request: WorkspaceInspectRequest,
): Promise<WorkspaceInspectResult> =>
  window.sugarcode.inspectWorkspace(request);
