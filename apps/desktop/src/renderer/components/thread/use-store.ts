import {
  type UIEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

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
  TranscriptFollow,
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
  previous?: ThreadViewModel,
): ThreadViewModel => {
  const previousTurns = new Map(
    previous?.turns.map((turn) => [turn.id, turn]) ?? [],
  );
  const turns = snapshot.turns.map(
    (turn): TurnViewModel => {
      const previousTurn = previousTurns.get(turn.id);
      const messages = turn.messages.map(
        (message): TranscriptMessageViewModel => {
          const previousMessage = previousTurn?.messages.find(
            (entry) => entry.message.id === message.id,
          );
          if (message.role === 'user') {
            if (
              previousMessage?.role === 'user' &&
              previousMessage.message.text === message.text
            ) {
              return previousMessage;
            }
            return {
              role: 'user',
              message: { id: message.id, text: message.text },
            };
          }
          const state = toAgentMessagePresentationState(
            snapshot.phase,
            message.status,
          );
          if (
            previousMessage?.role === 'agent' &&
            previousMessage.message.text === message.text &&
            previousMessage.message.state === state
          ) {
            return previousMessage;
          }
          return {
            role: 'agent',
            message: {
              id: message.id,
              text: message.text,
              state,
            },
          };
        },
      );
      const stableMessages =
        previousTurn &&
        previousTurn.messages.length === messages.length &&
        previousTurn.messages.every(
          (message, index) => message === messages[index],
        )
          ? previousTurn.messages
          : messages;
      const nextFailure = turn.error
        ? toTurnFailureViewModel(turn.error)
        : undefined;
      const failure =
        nextFailure &&
        previousTurn?.failure?.summary === nextFailure.summary &&
        previousTurn.failure.guidance === nextFailure.guidance &&
        previousTurn.failure.retryable === nextFailure.retryable
          ? previousTurn.failure
          : nextFailure;
      const terminalLabel = TERMINAL_LABELS[turn.status];
      const isError = turn.status === 'failed';
      if (
        previousTurn?.status === turn.status &&
        previousTurn.messages === stableMessages &&
        previousTurn.terminalLabel === terminalLabel &&
        previousTurn.failure === failure &&
        previousTurn.isError === isError
      ) {
        return previousTurn;
      }
      return {
        id: turn.id,
        status: turn.status,
        messages: stableMessages,
        ...(terminalLabel ? { terminalLabel } : {}),
        ...(failure ? { failure } : {}),
        isError,
      };
    },
  );
  const stableTurns =
    previous &&
    previous.turns.length === turns.length &&
    previous.turns.every((turn, index) => turn === turns[index])
      ? previous.turns
      : turns;

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
    turns: stableTurns,
    isEmpty: stableTurns.length === 0,
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

export const useTranscriptFollow = (
  thread: ThreadViewModel,
): TranscriptFollow => {
  const transcriptEnd = useRef<HTMLDivElement | null>(null);
  const shouldFollowTranscript = useRef<boolean>(true);

  const recordScrollPosition = (event: UIEvent<HTMLDivElement>): void => {
    const viewport = event.currentTarget;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    shouldFollowTranscript.current = distanceFromBottom <= 48;
  };

  useEffect(() => {
    if (shouldFollowTranscript.current) {
      transcriptEnd.current?.scrollIntoView({ block: 'end' });
    }
  }, [thread.turns, thread.phase]);

  return { transcriptEnd, recordScrollPosition };
};

export const useStore = (): ThreadStore => {
  const [snapshot, setSnapshot] =
    useState<ConversationStateSnapshot>(INITIAL_SNAPSHOT);
  const [draft, setDraft] = useState<string>('');
  const [isSending, setIsSending] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const revision = useRef<number>(-1);
  const previousThread = useRef<ThreadViewModel | undefined>(undefined);

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

  const thread = useMemo<ThreadViewModel>(() => {
    const next = toThreadViewModel(snapshot, previousThread.current);
    previousThread.current = next;
    return next;
  }, [snapshot]);
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
