import type { ConversationTurnStatus } from '@/shared/conversation';

export const shouldAutoExpandActivityGroup = (
  status: ConversationTurnStatus,
  requiresAttention: boolean,
): boolean => status === 'inProgress' || requiresAttention;

export const processActivityLabel = (
  status: ConversationTurnStatus,
  requiresAttention: boolean,
): string => {
  if (requiresAttention) {
    return 'Action required';
  }
  switch (status) {
    case 'inProgress':
      return 'Working';
    case 'interrupted':
      return 'Process stopped';
    case 'failed':
      return 'Process failed';
    case 'completed':
      return 'Processed';
  }
};
