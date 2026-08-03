import type { ConversationTerminalTurnStatus } from '@/shared/conversation';

import type { ThreadNavigationStatus } from './types';

export const toThreadNavigationStatus = ({
  approvalRequired,
  pending,
  reloadRequired = false,
  running,
  terminalStatus,
}: Readonly<{
  approvalRequired: boolean;
  pending: boolean;
  reloadRequired?: boolean;
  running: boolean;
  terminalStatus?: ConversationTerminalTurnStatus;
}>): ThreadNavigationStatus => {
  if (approvalRequired) {
    return 'approvalRequired';
  }
  if (pending) {
    return 'opening';
  }
  if (reloadRequired) {
    return 'reloadRequired';
  }
  if (running) {
    return 'running';
  }
  return terminalStatus ?? 'idle';
};
