import type { ConversationTurn } from '@/shared/conversation';

import type { ResumeSnapshot } from './protocol';

export type RecoveredConversation = Readonly<{
  threadId: string;
  turns: readonly ConversationTurn[];
}>;

export const recoverConversation = (
  expectedThreadId: string,
  snapshot: ResumeSnapshot,
): RecoveredConversation => {
  if (snapshot.threadId !== expectedThreadId) {
    throw new Error('thread/resume returned another Thread.');
  }

  const turnIds = new Set<string>();
  const itemIds = new Set<string>();
  const turns = snapshot.turns.map((turn): ConversationTurn => {
    if (turn.status === 'inProgress') {
      throw new Error('thread/resume returned an in-progress Turn.');
    }
    if (turnIds.has(turn.id)) {
      throw new Error('thread/resume returned a duplicate Turn ID.');
    }
    turnIds.add(turn.id);

    const messages = turn.items.flatMap((item) => {
      if (itemIds.has(item.id)) {
        throw new Error('thread/resume returned a duplicate Item ID.');
      }
      itemIds.add(item.id);
      if (item.type === 'other') {
        return [];
      }
      return [
        {
          id: item.id,
          role: item.type === 'userMessage' ? 'user' : 'agent',
          text: item.text,
          status: 'completed',
        } as const,
      ];
    });

    return {
      id: turn.id,
      status: turn.status,
      messages,
      ...(turn.error ? { error: { ...turn.error } } : {}),
    };
  });

  return {
    threadId: snapshot.threadId,
    turns,
  };
};
