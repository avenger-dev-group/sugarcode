import type { ConversationPhase } from '../../../shared/conversation.ts';

import type { TurnViewModel } from './types';

export type EditableMessageTarget = Readonly<{
  turnId: string;
  messageId: string;
}>;

export const latestEditableMessageTarget = (
  turns: readonly TurnViewModel[],
  phase: ConversationPhase,
  isSending: boolean,
): EditableMessageTarget | null => {
  const latestTurn = turns.at(-1);
  if (
    phase !== 'ready' ||
    isSending ||
    latestTurn === undefined ||
    latestTurn.status === 'inProgress'
  ) {
    return null;
  }
  const originMessage = latestTurn.messages.find(
    (message) => message.role === 'user',
  );
  return originMessage?.role === 'user'
    ? { turnId: latestTurn.id, messageId: originMessage.message.id }
    : null;
};

export const isSameEditableMessageTarget = (
  left: EditableMessageTarget | null,
  right: EditableMessageTarget | null,
): boolean =>
  left?.turnId === right?.turnId && left?.messageId === right?.messageId;

export const hasCopyableUserText = (text: string): boolean =>
  text.trim().length > 0;
