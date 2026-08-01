import type { CommandApprovalMode } from '../../../shared/command-approval.ts';

export type CommandApprovalModeScope = Readonly<{
  mode: CommandApprovalMode;
  threadId?: string;
  bindNextThread: boolean;
}>;

export const createCommandApprovalModeScope = (
  mode: CommandApprovalMode,
  threadId: string | null = null,
): CommandApprovalModeScope => ({
  mode,
  ...(mode === 'thread' && threadId ? { threadId } : {}),
  bindNextThread: mode === 'thread' && threadId === null,
});

export const evaluateAutomaticCommandApproval = (
  scope: CommandApprovalModeScope,
  threadId: string,
): Readonly<{
  approveAutomatically: boolean;
  scope: CommandApprovalModeScope;
}> => {
  if (scope.mode === 'workspace') {
    return { approveAutomatically: true, scope };
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
