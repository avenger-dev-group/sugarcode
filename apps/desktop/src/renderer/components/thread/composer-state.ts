import type { WorkspaceStateSnapshot } from '@/shared/workspace';

export const shouldStartChatOnSend = (
  workspace: WorkspaceStateSnapshot,
): boolean =>
  workspace.kind === undefined &&
  (workspace.status === 'unselected' || workspace.status === 'failed');

export const canRemoveDraftProject = (
  workspace: WorkspaceStateSnapshot,
  threadIdentity: string | null,
): boolean =>
  workspace.status === 'ready' &&
  workspace.kind === 'project' &&
  threadIdentity === null;
