import type { ConversationTerminalTurnStatus } from '@/shared/conversation';

import type { ThreadNavigationStatus } from './types';

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
  approvalRequired,
  pending,
  running,
  terminalStatus,
}: Readonly<{
  approvalRequired: boolean;
  pending: boolean;
  running: boolean;
  terminalStatus?: ConversationTerminalTurnStatus;
}>): ThreadNavigationStatus => {
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
