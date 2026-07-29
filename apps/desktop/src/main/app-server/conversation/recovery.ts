import type {
  ConversationMessage,
  ConversationTurn,
  ConversationWorkspaceReadActivity,
} from '@/shared/conversation';

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

    const messages: ConversationMessage[] = [];
    let workspaceRead: ConversationWorkspaceReadActivity | undefined;
    for (const item of turn.items) {
      if (itemIds.has(item.id)) {
        throw new Error('thread/resume returned a duplicate Item ID.');
      }
      itemIds.add(item.id);
      if (item.type === 'userMessage' || item.type === 'agentMessage') {
        messages.push({
          id: item.id,
          role: item.type === 'userMessage' ? 'user' : 'agent',
          text: item.text,
          status: 'completed',
        });
        continue;
      }
      if (item.type === 'workspaceReadCall') {
        if (workspaceRead) {
          throw new Error(
            'thread/resume returned duplicate workspace/read activity.',
          );
        }
        workspaceRead = {
          id: item.id,
          callId: item.callId,
          path: item.path,
          callStatus: 'completed',
        };
        continue;
      }
      if (item.type === 'workspaceReadResult') {
        if (
          !workspaceRead ||
          workspaceRead.callId !== item.callId ||
          workspaceRead.result
        ) {
          throw new Error(
            'thread/resume returned an unmatched workspace/read result.',
          );
        }
        workspaceRead = {
          ...workspaceRead,
          result: {
            id: item.id,
            status: 'completed',
            outcome: { ...item.outcome },
          },
        };
      }
    }

    if (
      workspaceRead &&
      turn.status !== 'interrupted' &&
      !workspaceRead.result
    ) {
      throw new Error(
        'thread/resume returned terminal workspace/read activity without a result.',
      );
    }

    return {
      id: turn.id,
      status: turn.status,
      messages,
      ...(workspaceRead ? { workspaceRead } : {}),
      ...(turn.error ? { error: { ...turn.error } } : {}),
    };
  });

  return {
    threadId: snapshot.threadId,
    turns,
  };
};
