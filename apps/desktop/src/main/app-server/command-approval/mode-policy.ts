import type { CommandApprovalMode } from '../../../shared/command-approval.ts';

export type CommandApprovalModeScope = Readonly<{
  mode: CommandApprovalMode;
  threadId?: string;
  workspaceId?: string;
  bindNextThread: boolean;
}>;

export const createCommandApprovalModeScope = (
  mode: CommandApprovalMode,
  threadId: string | null = null,
  workspaceId: string | null = null,
): CommandApprovalModeScope => ({
  mode,
  ...(mode === 'thread' && threadId ? { threadId } : {}),
  ...(mode === 'workspace' && workspaceId ? { workspaceId } : {}),
  bindNextThread: mode === 'thread' && threadId === null,
});

export const evaluateAutomaticCommandApproval = (
  scope: CommandApprovalModeScope,
  threadId: string,
  workspaceId: string | null = null,
): Readonly<{
  approveAutomatically: boolean;
  scope: CommandApprovalModeScope;
}> => {
  if (scope.mode === 'workspace') {
    return {
      approveAutomatically:
        scope.workspaceId !== undefined && scope.workspaceId === workspaceId,
      scope,
    };
  }
  if (scope.mode !== 'thread') {
    return { approveAutomatically: false, scope };
  }
  if (scope.bindNextThread) {
    return {
      approveAutomatically: true,
      scope: createCommandApprovalModeScope('thread', threadId),
    };
  }
  if (scope.threadId === threadId) {
    return { approveAutomatically: true, scope };
  }
  return {
    approveAutomatically: false,
    scope: createCommandApprovalModeScope('ask'),
  };
};
