import type {
  WorkspaceInspectRequest,
  WorkspaceInspectResult,
  WorkspaceListRequest,
  WorkspaceListResult,
  WorkspacePathSearchRequest,
  WorkspacePathSearchResult,
  WorkspaceResolveRequest,
  WorkspaceResolveResult,
  WorkspaceSelectResult,
  WorkspaceStateSnapshot,
  WorkspaceTaskRenameRequest,
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

export const removeWorkspaceProject = (
  projectId: string,
): Promise<WorkspaceSelectResult> =>
  window.sugarcode.removeWorkspaceProject(projectId);

export const focusWorkspaceTask = (
  threadId: string,
): Promise<WorkspaceSelectResult> =>
  window.sugarcode.focusWorkspaceTask(threadId);

export const deleteWorkspaceTask = (
  threadId: string,
): Promise<WorkspaceSelectResult> =>
  window.sugarcode.deleteWorkspaceTask(threadId);

export const renameWorkspaceTask = (
  request: WorkspaceTaskRenameRequest,
): Promise<WorkspaceSelectResult> =>
  window.sugarcode.renameWorkspaceTask(request);

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

export const searchWorkspacePaths = (
  request: WorkspacePathSearchRequest,
): Promise<WorkspacePathSearchResult> =>
  window.sugarcode.searchWorkspacePaths(request);

export const inspectWorkspace = (
  request: WorkspaceInspectRequest,
): Promise<WorkspaceInspectResult> =>
  window.sugarcode.inspectWorkspace(request);

export const resolveWorkspaceFile = (
  request: WorkspaceResolveRequest,
): Promise<WorkspaceResolveResult> =>
  window.sugarcode.resolveWorkspaceFile(request);
