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
  type ConversationCommandApprovalActivity,
  type ConversationPhase,
  type ConversationStateSnapshot,
  type ConversationTurnStatus,
  type ConversationWorkspaceListActivity,
  type ConversationWorkspaceReadActivity,
  type ConversationWorkspaceSearchActivity,
} from '@/shared/conversation';

import type {
  AgentMessagePresentationState,
  CommandApprovalActivityViewModel,
  CommandApprovalPresentationState,
  CommandExecutionAttemptPresentationState,
  WorkspaceListActivityViewModel,
  WorkspaceListPresentationState,
  WorkspaceReadActivityViewModel,
  WorkspaceReadPresentationState,
  WorkspaceSearchActivityViewModel,
  WorkspaceSearchPresentationState,
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

const toWorkspaceReadPresentationState = (
  phase: ConversationPhase,
  turnStatus: ConversationTurnStatus,
  activity: ConversationWorkspaceReadActivity,
): WorkspaceReadPresentationState => {
  if (activity.result?.status === 'completed') {
    return activity.result.outcome.type === 'success'
      ? 'succeeded'
      : 'failed';
  }
  if (turnStatus === 'interrupted') {
    return 'interrupted';
  }
  if (turnStatus !== 'inProgress') {
    throw new Error('A terminal workspace read has no durable result.');
  }
  switch (phase) {
    case 'inProgress':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'unavailable':
      return 'uncertain';
    default:
      throw new Error('Workspace read activity did not match its Turn phase.');
  }
};

const toWorkspaceListPresentationState = (
  phase: ConversationPhase,
  turnStatus: ConversationTurnStatus,
  activity: ConversationWorkspaceListActivity,
): WorkspaceListPresentationState => {
  if (activity.result?.status === 'completed') {
    return activity.result.outcome.type === 'success'
      ? 'succeeded'
      : 'failed';
  }
  if (turnStatus === 'interrupted') {
    return 'interrupted';
  }
  if (turnStatus !== 'inProgress') {
    throw new Error('A terminal workspace list has no durable result.');
  }
  switch (phase) {
    case 'inProgress':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'unavailable':
      return 'uncertain';
    default:
      throw new Error('Workspace list activity did not match its Turn phase.');
  }
};

const toWorkspaceSearchPresentationState = (
  phase: ConversationPhase,
  turnStatus: ConversationTurnStatus,
  activity: ConversationWorkspaceSearchActivity,
): WorkspaceSearchPresentationState => {
  if (activity.result?.status === 'completed') {
    return activity.result.outcome.type === 'success'
      ? 'succeeded'
      : 'failed';
  }
  if (turnStatus === 'interrupted') {
    return 'interrupted';
  }
  if (turnStatus !== 'inProgress') {
    throw new Error('A terminal workspace search has no durable result.');
  }
  switch (phase) {
    case 'inProgress':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'unavailable':
      return 'uncertain';
    default:
      throw new Error('Workspace search activity did not match its Turn phase.');
  }
};

const toCommandApprovalPresentationState = (
  phase: ConversationPhase,
  turnStatus: ConversationTurnStatus,
  activity: ConversationCommandApprovalActivity,
): CommandApprovalPresentationState => {
  if (activity.decision?.status === 'completed') {
    return activity.decision.value;
  }
  if (turnStatus === 'interrupted') {
    return 'interrupted';
  }
  if (turnStatus !== 'inProgress') {
    throw new Error('A terminal command approval has no durable decision.');
  }
  switch (phase) {
    case 'inProgress':
      return 'awaiting';
    case 'stopping':
      return 'stopping';
    case 'unavailable':
      return 'uncertain';
    default:
      throw new Error('Command approval activity did not match its Turn phase.');
  }
};

const toCommandExecutionAttemptPresentationState = (
  phase: ConversationPhase,
  status: ConversationMessageStatus,
): CommandExecutionAttemptPresentationState => {
  if (status === 'completed') {
    return 'recorded';
  }
  switch (phase) {
    case 'inProgress':
      return 'observed';
    case 'stopping':
      return 'stopping';
    case 'unavailable':
      return 'uncertain';
    default:
      throw new Error(
        'Command execution attempt did not match its Turn phase.',
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
      const nextWorkspaceRead = turn.workspaceRead
        ? (() => {
            const state = toWorkspaceReadPresentationState(
              snapshot.phase,
              turn.status,
              turn.workspaceRead,
            );
            const outcome = turn.workspaceRead.result?.outcome;
            return {
              id: turn.workspaceRead.id,
              path: turn.workspaceRead.path,
              state,
              ...(outcome?.type === 'success'
                ? { bytes: outcome.bytes }
                : {}),
              ...(outcome?.type === 'error'
                ? { errorKind: outcome.kind }
                : {}),
            } satisfies WorkspaceReadActivityViewModel;
          })()
        : undefined;
      const workspaceRead =
        nextWorkspaceRead &&
        previousTurn?.workspaceRead?.id === nextWorkspaceRead.id &&
        previousTurn.workspaceRead.path === nextWorkspaceRead.path &&
        previousTurn.workspaceRead.state === nextWorkspaceRead.state &&
        previousTurn.workspaceRead.bytes === nextWorkspaceRead.bytes &&
        previousTurn.workspaceRead.errorKind === nextWorkspaceRead.errorKind
          ? previousTurn.workspaceRead
          : nextWorkspaceRead;
      const nextWorkspaceList = turn.workspaceList
        ? (() => {
            const state = toWorkspaceListPresentationState(
              snapshot.phase,
              turn.status,
              turn.workspaceList,
            );
            const outcome = turn.workspaceList.result?.outcome;
            return {
              id: turn.workspaceList.id,
              path: turn.workspaceList.path,
              state,
              ...(outcome?.type === 'success'
                ? { entries: outcome.entries }
                : {}),
              ...(outcome?.type === 'error'
                ? { errorKind: outcome.kind }
                : {}),
            } satisfies WorkspaceListActivityViewModel;
          })()
        : undefined;
      const workspaceList =
        nextWorkspaceList &&
        previousTurn?.workspaceList?.id === nextWorkspaceList.id &&
        previousTurn.workspaceList.path === nextWorkspaceList.path &&
        previousTurn.workspaceList.state === nextWorkspaceList.state &&
        previousTurn.workspaceList.entries === nextWorkspaceList.entries &&
        previousTurn.workspaceList.errorKind === nextWorkspaceList.errorKind
          ? previousTurn.workspaceList
          : nextWorkspaceList;
      const nextWorkspaceSearch = turn.workspaceSearch
        ? (() => {
            const state = toWorkspaceSearchPresentationState(
              snapshot.phase,
              turn.status,
              turn.workspaceSearch,
            );
            const outcome = turn.workspaceSearch.result?.outcome;
            return {
              id: turn.workspaceSearch.id,
              path: turn.workspaceSearch.path,
              query: turn.workspaceSearch.query,
              state,
              ...(outcome?.type === 'success'
                ? {
                    matches: outcome.matches,
                    truncated: outcome.truncated,
                  }
                : {}),
              ...(outcome?.type === 'error'
                ? { errorKind: outcome.kind }
                : {}),
            } satisfies WorkspaceSearchActivityViewModel;
          })()
        : undefined;
      const workspaceSearch =
        nextWorkspaceSearch &&
        previousTurn?.workspaceSearch?.id === nextWorkspaceSearch.id &&
        previousTurn.workspaceSearch.path === nextWorkspaceSearch.path &&
        previousTurn.workspaceSearch.query === nextWorkspaceSearch.query &&
        previousTurn.workspaceSearch.state === nextWorkspaceSearch.state &&
        previousTurn.workspaceSearch.matches === nextWorkspaceSearch.matches &&
        previousTurn.workspaceSearch.truncated ===
          nextWorkspaceSearch.truncated &&
        previousTurn.workspaceSearch.errorKind ===
          nextWorkspaceSearch.errorKind
          ? previousTurn.workspaceSearch
          : nextWorkspaceSearch;
      const nextCommandApproval = turn.commandApproval
        ? {
            id: turn.commandApproval.id,
            command: turn.commandApproval.command,
            argumentCount: turn.commandApproval.argumentCount,
            state: toCommandApprovalPresentationState(
              snapshot.phase,
              turn.status,
              turn.commandApproval,
            ),
            ...(turn.commandApproval.executionAttempt
              ? {
                  executionAttempt: {
                    id: turn.commandApproval.executionAttempt.id,
                    state: toCommandExecutionAttemptPresentationState(
                      snapshot.phase,
                      turn.commandApproval.executionAttempt.status,
                    ),
                  },
                }
              : {}),
          } satisfies CommandApprovalActivityViewModel
        : undefined;
      const commandApproval =
        nextCommandApproval &&
        previousTurn?.commandApproval?.id === nextCommandApproval.id &&
        previousTurn.commandApproval.command === nextCommandApproval.command &&
        previousTurn.commandApproval.argumentCount ===
          nextCommandApproval.argumentCount &&
        previousTurn.commandApproval.state === nextCommandApproval.state &&
        previousTurn.commandApproval.executionAttempt?.id ===
          nextCommandApproval.executionAttempt?.id &&
        previousTurn.commandApproval.executionAttempt?.state ===
          nextCommandApproval.executionAttempt?.state
          ? previousTurn.commandApproval
          : nextCommandApproval;
      const nextFailure = turn.error
        ? toTurnFailureViewModel(turn.error)
        : undefined;
      const failure =
        nextFailure &&
        previousTurn?.failure?.kind === nextFailure.kind &&
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
        previousTurn.workspaceRead === workspaceRead &&
        previousTurn.workspaceList === workspaceList &&
        previousTurn.workspaceSearch === workspaceSearch &&
        previousTurn.commandApproval === commandApproval &&
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
        ...(workspaceRead ? { workspaceRead } : {}),
        ...(workspaceList ? { workspaceList } : {}),
        ...(workspaceSearch ? { workspaceSearch } : {}),
        ...(commandApproval ? { commandApproval } : {}),
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
    threadIdentity: snapshot.threadId ?? null,
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
