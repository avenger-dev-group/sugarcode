import type { ConversationTurnStatus } from '@/shared/conversation';

export const shouldAutoExpandActivityGroup = (
  status: ConversationTurnStatus,
  requiresAttention: boolean,
): boolean => status === 'inProgress' || requiresAttention;
