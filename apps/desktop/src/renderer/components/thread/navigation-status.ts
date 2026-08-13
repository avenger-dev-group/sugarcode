import type { ConversationTerminalTurnStatus } from '@/shared/conversation';

import type { ThreadNavigationStatus } from './types';

export const resolveDisplayedThreadId = ({
  active,
  pendingThreadId,
  selectedThreadId,
  threadIds,
}: Readonly<{
  active: boolean;
  pendingThreadId: string | null;
  selectedThreadId: string | null;
  threadIds: readonly string[];
}>): string | null => {
  if (pendingThreadId && threadIds.includes(pendingThreadId)) {
    return pendingThreadId;
  }
  return active ? selectedThreadId : null;
};

export const isThreadDeleteDisabled = ({
  lifecycleMutationPending,
  running,
  workspaceBusy,
}: Readonly<{
  lifecycleMutationPending: boolean;
  running: boolean;
  workspaceBusy: boolean;
}>): boolean => workspaceBusy || lifecycleMutationPending || running;

export const toThreadNavigationStatus = ({
  inputRequired,
  approvalRequired,
  pending,
  running,
  terminalStatus,
}: Readonly<{
  inputRequired: boolean;
  approvalRequired: boolean;
  pending: boolean;
  running: boolean;
  terminalStatus?: ConversationTerminalTurnStatus;
}>): ThreadNavigationStatus => {
  if (inputRequired) {
    return 'inputRequired';
  }
  if (approvalRequired) {
    return 'approvalRequired';
  }
  if (pending) {
    return 'opening';
  }
  if (running) {
    return 'running';
  }
  return terminalStatus ?? 'idle';
};
