import type { WorkspaceStateSnapshot } from '@/shared/workspace';

export const shouldStartChatOnSend = (
  workspace: WorkspaceStateSnapshot,
): boolean =>
  workspace.kind === undefined &&
  (workspace.status === 'unselected' || workspace.status === 'failed');
