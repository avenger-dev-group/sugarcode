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

export const listWorkspace = (
  request: WorkspaceListRequest,
): Promise<WorkspaceListResult> =>
  window.sugarcode.listWorkspace(request);

export const inspectWorkspace = (
  request: WorkspaceInspectRequest,
): Promise<WorkspaceInspectResult> =>
  window.sugarcode.inspectWorkspace(request);
