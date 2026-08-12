import type { ConversationPhase } from '../../../shared/conversation.ts';

import type { TurnViewModel } from './types';

export const latestEditableTurnId = (
  turns: readonly TurnViewModel[],
  phase: ConversationPhase,
  isSending: boolean,
): string | null => {
  const latestTurn = turns.at(-1);
  return phase === 'ready' &&
    !isSending &&
    latestTurn !== undefined &&
    latestTurn.status !== 'inProgress' &&
    latestTurn.messages.some((message) => message.role === 'user')
    ? latestTurn.id
    : null;
};
