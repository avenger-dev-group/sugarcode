import type { ConversationTerminalTurnStatus } from '@/shared/conversation';

import type { ThreadNavigationStatus } from './types';

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
