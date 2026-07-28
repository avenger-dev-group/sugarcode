import { useEffect, useMemo, useRef, useState } from 'react';

import {
  getConversationState,
  onConversationStateChanged,
  sendConversationMessage,
  stopConversationTurn,
} from '@/renderer/services/conversation';
import {
  MAX_CONVERSATION_INPUT_BYTES,
  type ConversationMessageStatus,
  type ConversationPhase,
  type ConversationStateSnapshot,
  type ConversationTurnStatus,
} from '@/shared/conversation';

import type {
  AgentMessagePresentationState,
} from '../agent/types';
import type {
  ThreadStore,
  ThreadViewModel,
  TranscriptMessageViewModel,
  TurnViewModel,
} from './types';
import { toTurnFailureViewModel } from './turn-failure';

const INITIAL_SNAPSHOT: ConversationStateSnapshot = {
  revision: 0,
  phase: 'unavailable',
  turns: [],
};

const TERMINAL_LABELS: Record<
  ConversationTurnStatus,
  string | undefined
> = {
  completed: 'Turn complete',
  failed: 'Turn failed',
  interrupted: 'Turn stopped',
  inProgress: undefined,
} as const;

const toAgentMessagePresentationState = (
  phase: ConversationPhase,
  status: ConversationMessageStatus,
): AgentMessagePresentationState => {
  if (status === 'completed') {
    return 'completed';
  }
  switch (phase) {
    case 'inProgress':
      return 'streaming';
    case 'stopping':
      return 'stopping';
    case 'unavailable':
      return 'uncertain';
    default:
      throw new Error(
        'An active AgentMessage did not match the conversation phase.',
      );
  }
};

export const toThreadViewModel = (
  snapshot: ConversationStateSnapshot,
): ThreadViewModel => {
  const turns = snapshot.turns.map(
    (turn): TurnViewModel => ({
      id: turn.id,
      status: turn.status,
      messages: turn.messages.map(
        (message): TranscriptMessageViewModel =>
          message.role === 'user'
            ? {
                role: 'user',
                message: { id: message.id, text: message.text },
              }
            : {
                role: 'agent',
                message: {
                  id: message.id,
                  text: message.text,
                  state: toAgentMessagePresentationState(
                    snapshot.phase,
                    message.status,
                  ),
                },
              },
      ),
      ...(TERMINAL_LABELS[turn.status]
        ? { terminalLabel: TERMINAL_LABELS[turn.status] }
        : {}),
      ...(turn.error
        ? { failure: toTurnFailureViewModel(turn.error) }
        : {}),
      isError: turn.status === 'failed',
    }),
  );

  const statusLabel = (() => {
    switch (snapshot.phase) {
      case 'starting':
        return 'Starting turn';
      case 'inProgress':
        return 'Agent working';
      case 'stopping':
        return 'Stopping safely';
      case 'unavailable':
        return 'Runtime unavailable';
      case 'ready':
        return 'Ready for the next turn';
      default:
        return 'Ready for a first turn';
    }
  })();

  return {
    phase: snapshot.phase,
    threadLabel: snapshot.threadId
      ? `Thread ${snapshot.threadId.slice(-6)}`
      : 'New local thread',
    turns,
    isEmpty: turns.length === 0,
    statusLabel,
    ...(snapshot.notice ? { notice: snapshot.notice.summary } : {}),
  };
};

const inputBytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

export const shouldAcceptSnapshot = (
  currentRevision: number,
  snapshot: ConversationStateSnapshot,
): boolean => snapshot.revision > currentRevision;

export const useStore = (): ThreadStore => {
  const [snapshot, setSnapshot] =
    useState<ConversationStateSnapshot>(INITIAL_SNAPSHOT);
  const [draft, setDraft] = useState<string>('');
  const [isSending, setIsSending] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const revision = useRef<number>(-1);

  useEffect(() => {
    let active = true;
    const acceptSnapshot = (next: ConversationStateSnapshot): void => {
      if (active && shouldAcceptSnapshot(revision.current, next)) {
        revision.current = next.revision;
        setSnapshot(next);
      }
    };
    const unsubscribe = onConversationStateChanged(acceptSnapshot);
    void getConversationState().then(acceptSnapshot).catch(() => {
      if (active) {
        setActionError('Desktop could not read the current conversation.');
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const bytes = inputBytes(draft);
  const phaseAllowsSend =
    snapshot.phase === 'idle' || snapshot.phase === 'ready';
  const canSend =
    phaseAllowsSend &&
    !isSending &&
    draft.trim().length > 0 &&
    bytes <= MAX_CONVERSATION_INPUT_BYTES;
  const canStop =
    snapshot.phase === 'inProgress' || snapshot.phase === 'stopping';

  const send = async (): Promise<void> => {
    if (!canSend) {
      return;
    }
    setIsSending(true);
    setActionError(null);
    try {
      const result = await sendConversationMessage(draft);
      if (result.accepted) {
        setDraft('');
      } else {
        setActionError(
          result.reason === 'invalidInput'
            ? 'Enter a message within the 64 KiB limit.'
            : 'The local Agent is not ready for another Turn.',
        );
      }
    } catch {
      setActionError('Desktop could not send this message safely.');
    } finally {
      setIsSending(false);
    }
  };

  const stop = async (): Promise<void> => {
    if (!canStop || snapshot.phase === 'stopping') {
      return;
    }
    setActionError(null);
    try {
      const result = await stopConversationTurn();
      if (!result.accepted) {
        setActionError('The active Turn could not be stopped safely.');
      }
    } catch {
      setActionError('Desktop could not request a safe stop.');
    }
  };

  const thread = useMemo<ThreadViewModel>(
    () => toThreadViewModel(snapshot),
    [snapshot],
  );
  const inputHint =
    bytes > MAX_CONVERSATION_INPUT_BYTES
      ? 'Message exceeds the 64 KiB limit'
      : `${Math.ceil(bytes / 1024)} / 64 KiB`;

  return {
    thread,
    draft,
    inputBytes: bytes,
    inputLimitBytes: MAX_CONVERSATION_INPUT_BYTES,
    inputHint,
    canSend,
    canStop,
    isSending,
    actionError,
    setDraft,
    send,
    stop,
  };
};
