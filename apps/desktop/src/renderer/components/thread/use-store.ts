import {
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  archiveConversationThread,
  deleteConversationThread,
  forkConversationThread,
  getConversationState,
  onConversationStateChanged,
  selectConversationThread,
  sendConversationMessage,
  startNewConversationThread,
  stopConversationTurn,
  unarchiveConversationThread,
} from '@/renderer/services/conversation';
import {
  getModelConfig,
  MODEL_CONFIG_CHANGED_EVENT,
} from '@/renderer/services/model-config';
import {
  MAX_CONVERSATION_INPUT_BYTES,
  MAX_CONVERSATION_ATTACHMENTS,
  MAX_CONVERSATION_ATTACHMENT_BYTES,
  type ConversationActionResult,
  type ConversationMessageStatus,
  type ConversationCommandApprovalActivity,
  type ConversationMcpActivity,
  type ConversationPhase,
  type ConversationStateSnapshot,
  type ConversationThreadNavigatorSnapshot,
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
  CommandExecutionResultPresentationState,
  WorkspaceListActivityViewModel,
  WorkspaceListPresentationState,
  WorkspaceReadActivityViewModel,
  WorkspaceReadPresentationState,
  WorkspaceSearchActivityViewModel,
  WorkspaceSearchPresentationState,
} from '../agent/types';
import { toFileChangeReviewViewModel } from '../workspace/use-store';
import type { McpActivityState, McpActivityViewModel } from '../mcp/types';
import type {
  ActivityDisclosureStore,
  ThreadStore,
  ThreadNavigatorViewModel,
  ThreadViewModel,
  DraftAttachmentViewModel,
  TranscriptFollow,
  TranscriptMessageViewModel,
  TurnViewModel,
} from './types';
import {
  formatTokenUsageHint,
  latestTurnUsage,
} from './context-budget';
import {
  latestDurableModelProfileId,
  resolveModelProfileId,
} from './model-selection';
import {
  isTranscriptScrollUpKey,
  shouldFollowTranscriptAfterScroll,
} from './transcript-follow';
import {
  completedProcessDurationLabel,
  processLanguageFromText,
} from './activity-disclosure';
import { toTurnFailureViewModel } from './turn-failure';
import { toActiveTurnProgress } from './turn-progress';

export const useActivityDisclosureStore = (
  groupId: string,
  initiallyExpanded = false,
): ActivityDisclosureStore => {
  const [expanded, setExpanded] = useState<boolean>(initiallyExpanded);

  useEffect(() => {
    setExpanded(initiallyExpanded);
  }, [groupId, initiallyExpanded]);

  return { expanded, setExpanded };
};

const INITIAL_SNAPSHOT: ConversationStateSnapshot = {
  revision: 0,
  phase: 'unavailable',
  turns: [],
  navigator: {
    status: 'unavailable',
    activeThreadIds: [],
    activeThreadTitles: {},
    activeTruncated: false,
    search: {
      query: '',
      status: 'idle',
      threadIds: [],
      threadTitles: {},
      truncated: false,
    },
  },
};

type ConversationProjectionSnapshot = Omit<
  ConversationStateSnapshot,
  'navigator'
> &
  Readonly<{ navigator?: ConversationThreadNavigatorSnapshot }>;

const TERMINAL_LABELS: Record<ConversationTurnStatus, string | undefined> = {
  completed: undefined,
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
    return activity.result.outcome.type === 'success' ? 'succeeded' : 'failed';
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
    return activity.result.outcome.type === 'success' ? 'succeeded' : 'failed';
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
    return activity.result.outcome.type === 'success' ? 'succeeded' : 'failed';
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
      throw new Error(
        'Workspace search activity did not match its Turn phase.',
      );
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
      throw new Error(
        'Command approval activity did not match its Turn phase.',
      );
  }
};

const toMcpActivityState = (
  phase: ConversationPhase,
  turnStatus: ConversationTurnStatus,
  activity: ConversationMcpActivity,
): McpActivityState => {
  if (activity.result?.status === 'completed') {
    return activity.result.receipt.type === 'error'
      ? 'failed'
      : activity.result.receipt.isError
        ? 'toolError'
        : 'succeeded';
  }
  if (turnStatus === 'interrupted') {
    return activity.executionAttempt ? 'uncertain' : 'stopped';
  }
  if (activity.executionAttempt?.status === 'completed') {
    return phase === 'unavailable' ? 'uncertain' : 'attempted';
  }
  if (activity.decision?.status === 'completed') {
    return activity.decision.value === 'approved' ? 'approved' : 'denied';
  }
  return phase === 'unavailable' ? 'uncertain' : 'awaiting';
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

const toCommandExecutionResultPresentationState = (
  phase: ConversationPhase,
  status: ConversationMessageStatus,
): CommandExecutionResultPresentationState => {
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
      throw new Error('Command execution result did not match its Turn phase.');
  }
};

export const toThreadViewModel = (
  snapshot: ConversationProjectionSnapshot,
  previous?: ThreadViewModel,
): ThreadViewModel => {
  const previousTurns = new Map(
    previous?.turns.map((turn) => [turn.id, turn]) ?? [],
  );
  const turns = snapshot.turns.map((turn): TurnViewModel => {
    const previousTurn = previousTurns.get(turn.id);
    const processLanguage = processLanguageFromText(
      turn.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.text)
        .join('\n'),
    );
    const model = turn.model
      ? {
          displayName: turn.model.displayName,
          wireApi: turn.model.wireApi,
        }
      : undefined;
    const messages = turn.messages.map(
      (message): TranscriptMessageViewModel => {
        const previousMessage = previousTurn?.messages.find(
          (entry) => entry.message.id === message.id,
        );
        if (message.role === 'user') {
          if (
            previousMessage?.role === 'user' &&
            previousMessage.message.text === message.text &&
            JSON.stringify(previousMessage.message.attachments) ===
              JSON.stringify(message.attachments ?? [])
          ) {
            return previousMessage;
          }
          return {
            role: 'user',
            message: {
              id: message.id,
              text: message.text,
              attachments: message.attachments ?? [],
            },
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
    const nextPendingAgentOutputs = turn.pendingAgentOutputs?.map((output) => ({
      id: `agent-output:${turn.id}:${output.responseOrdinal}:${output.outputIndex}`,
      text: output.text,
      state: 'streaming' as const,
    }));
    const pendingAgentOutputs =
      JSON.stringify(previousTurn?.pendingAgentOutputs) ===
      JSON.stringify(nextPendingAgentOutputs)
        ? previousTurn?.pendingAgentOutputs
        : nextPendingAgentOutputs;
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
            ...(outcome?.type === 'success' ? { bytes: outcome.bytes } : {}),
            ...(outcome?.type === 'error' ? { errorKind: outcome.kind } : {}),
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
            ...(outcome?.type === 'error' ? { errorKind: outcome.kind } : {}),
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
            ...(outcome?.type === 'error' ? { errorKind: outcome.kind } : {}),
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
      previousTurn.workspaceSearch.errorKind === nextWorkspaceSearch.errorKind
        ? previousTurn.workspaceSearch
        : nextWorkspaceSearch;
    const nextFileChange = turn.fileChange
      ? toFileChangeReviewViewModel(
          snapshot.phase,
          turn.status,
          turn.fileChange,
        )
      : undefined;
    const fileChange =
      nextFileChange &&
      previousTurn?.fileChange?.id === nextFileChange.id &&
      previousTurn.fileChange.path === nextFileChange.path &&
      previousTurn.fileChange.state === nextFileChange.state &&
      previousTurn.fileChange.errorKind === nextFileChange.errorKind &&
      JSON.stringify(previousTurn.fileChange.change) ===
        JSON.stringify(nextFileChange.change)
        ? previousTurn.fileChange
        : nextFileChange;
    const nextCommandApproval = turn.commandApproval
      ? ({
          id: turn.commandApproval.id,
          command: turn.commandApproval.command,
          argumentCount: turn.commandApproval.argumentCount,
          ...(turn.commandApproval.fullAccess
            ? { fullAccess: true }
            : {}),
          ...(turn.commandApproval.liveOutput
            ? { liveOutput: { ...turn.commandApproval.liveOutput } }
            : {}),
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
          ...(turn.commandApproval.executionResult
            ? {
                executionResult: {
                  id: turn.commandApproval.executionResult.id,
                  state: toCommandExecutionResultPresentationState(
                    snapshot.phase,
                    turn.commandApproval.executionResult.status,
                  ),
                  outcome: {
                    ...turn.commandApproval.executionResult.outcome,
                  },
                },
              }
            : {}),
        } satisfies CommandApprovalActivityViewModel)
      : undefined;
    const commandApproval =
      nextCommandApproval &&
      previousTurn?.commandApproval?.id === nextCommandApproval.id &&
      previousTurn.commandApproval.command === nextCommandApproval.command &&
      previousTurn.commandApproval.argumentCount ===
        nextCommandApproval.argumentCount &&
      previousTurn.commandApproval.fullAccess === nextCommandApproval.fullAccess &&
      JSON.stringify(previousTurn.commandApproval.liveOutput) ===
        JSON.stringify(nextCommandApproval.liveOutput) &&
      previousTurn.commandApproval.state === nextCommandApproval.state &&
      previousTurn.commandApproval.executionAttempt?.id ===
        nextCommandApproval.executionAttempt?.id &&
      previousTurn.commandApproval.executionAttempt?.state ===
        nextCommandApproval.executionAttempt?.state &&
      previousTurn.commandApproval.executionResult?.id ===
        nextCommandApproval.executionResult?.id &&
      previousTurn.commandApproval.executionResult?.state ===
        nextCommandApproval.executionResult?.state &&
      JSON.stringify(previousTurn.commandApproval.executionResult?.outcome) ===
        JSON.stringify(nextCommandApproval.executionResult?.outcome)
        ? previousTurn.commandApproval
        : nextCommandApproval;
    const nextMcpActivities = turn.mcpActivities?.map(
      (activity): McpActivityViewModel => ({
        id: activity.id,
        serverId: activity.serverId,
        name: activity.name,
        argumentsBytes: activity.argumentsBytes,
        argumentsSha256: activity.argumentsSha256,
        inventorySha256: activity.inventorySha256,
        state: toMcpActivityState(snapshot.phase, turn.status, activity),
        ...(activity.decision ? { decision: activity.decision.value } : {}),
        ...(activity.executionAttempt
          ? { attemptId: activity.executionAttempt.id }
          : {}),
        ...(activity.result
          ? {
              resultId: activity.result.id,
              receipt: { ...activity.result.receipt },
            }
          : {}),
      }),
    );
    const mcpActivities =
      nextMcpActivities &&
      JSON.stringify(previousTurn?.mcpActivities) ===
        JSON.stringify(nextMcpActivities)
        ? previousTurn?.mcpActivities
        : nextMcpActivities;
    const nextActivities = turn.activities?.map((entry) => {
      switch (entry.type) {
        case 'commentary':
          return {
            type: entry.type,
            activity: {
              id: entry.activity.id,
              text: entry.activity.text,
              state:
                entry.activity.status === 'completed'
                  ? ('completed' as const)
                  : ('running' as const),
            },
          } as const;
        case 'workspaceRead': {
          const outcome = entry.activity.result?.outcome;
          return {
            type: entry.type,
            activity: {
              id: entry.activity.id,
              path: entry.activity.path,
              state: toWorkspaceReadPresentationState(
                snapshot.phase,
                turn.status,
                entry.activity,
              ),
              ...(outcome?.type === 'success' ? { bytes: outcome.bytes } : {}),
              ...(outcome?.type === 'error' ? { errorKind: outcome.kind } : {}),
            },
          } as const;
        }
        case 'workspaceList': {
          const outcome = entry.activity.result?.outcome;
          return {
            type: entry.type,
            activity: {
              id: entry.activity.id,
              path: entry.activity.path,
              state: toWorkspaceListPresentationState(
                snapshot.phase,
                turn.status,
                entry.activity,
              ),
              ...(outcome?.type === 'success'
                ? { entries: outcome.entries }
                : {}),
              ...(outcome?.type === 'error' ? { errorKind: outcome.kind } : {}),
            },
          } as const;
        }
        case 'workspaceSearch': {
          const outcome = entry.activity.result?.outcome;
          return {
            type: entry.type,
            activity: {
              id: entry.activity.id,
              path: entry.activity.path,
              query: entry.activity.query,
              state: toWorkspaceSearchPresentationState(
                snapshot.phase,
                turn.status,
                entry.activity,
              ),
              ...(outcome?.type === 'success'
                ? {
                    matches: outcome.matches,
                    truncated: outcome.truncated,
                  }
                : {}),
              ...(outcome?.type === 'error' ? { errorKind: outcome.kind } : {}),
            },
          } as const;
        }
        case 'fileChange':
          return {
            type: entry.type,
            activity: toFileChangeReviewViewModel(
              snapshot.phase,
              turn.status,
              entry.activity,
            ),
          } as const;
        case 'commandApproval':
          return {
            type: entry.type,
            activity: {
              id: entry.activity.id,
              command: entry.activity.command,
              argumentCount: entry.activity.argumentCount,
              state: toCommandApprovalPresentationState(
                snapshot.phase,
                turn.status,
                entry.activity,
              ),
              ...(entry.activity.executionAttempt
                ? {
                    executionAttempt: {
                      id: entry.activity.executionAttempt.id,
                      state: toCommandExecutionAttemptPresentationState(
                        snapshot.phase,
                        entry.activity.executionAttempt.status,
                      ),
                    },
                  }
                : {}),
              ...(entry.activity.executionResult
                ? {
                    executionResult: {
                      id: entry.activity.executionResult.id,
                      state: toCommandExecutionResultPresentationState(
                        snapshot.phase,
                        entry.activity.executionResult.status,
                      ),
                      outcome: {
                        ...entry.activity.executionResult.outcome,
                      },
                    },
                  }
                : {}),
            },
          } as const;
        case 'mcp':
          return {
            type: entry.type,
            activity: {
              id: entry.activity.id,
              serverId: entry.activity.serverId,
              name: entry.activity.name,
              argumentsBytes: entry.activity.argumentsBytes,
              argumentsSha256: entry.activity.argumentsSha256,
              inventorySha256: entry.activity.inventorySha256,
              state: toMcpActivityState(
                snapshot.phase,
                turn.status,
                entry.activity,
              ),
              ...(entry.activity.decision
                ? { decision: entry.activity.decision.value }
                : {}),
              ...(entry.activity.executionAttempt
                ? { attemptId: entry.activity.executionAttempt.id }
                : {}),
              ...(entry.activity.result
                ? {
                    resultId: entry.activity.result.id,
                    receipt: { ...entry.activity.result.receipt },
                  }
                : {}),
            },
          } as const;
        case 'orchestration':
          return {
            type: entry.type,
            activity: {
              id: entry.activity.id,
              tasks: entry.activity.tasks.map((task) => ({
                id: task.id,
                taskId: task.taskId,
                clientTaskKey: task.clientTaskKey,
                childThreadId: task.childThreadId,
                title: task.title,
                role: task.role,
                access: task.access,
                dependsOn: [...task.dependsOn],
                taskMarkdown: task.taskMarkdown,
                status: task.status,
                amendments: task.amendments.map((amendment) => ({
                  ...amendment,
                })),
                ...(task.progress
                  ? { progress: { ...task.progress } }
                  : {}),
                ...(task.result ? { result: { ...task.result } } : {}),
              })),
            },
          } as const;
      }
    });
    const activities =
      nextActivities &&
      JSON.stringify(previousTurn?.activities) ===
        JSON.stringify(nextActivities)
        ? previousTurn?.activities
        : nextActivities;
    const nextFailure = turn.error
      ? toTurnFailureViewModel(turn.error, model?.wireApi)
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
    const completedAgentMessageId =
      turn.status === 'completed'
        ? turn.messages.findLast((message) => message.role === 'agent')?.id
        : undefined;
    const durationLabel = completedProcessDurationLabel(
      turn.id,
      completedAgentMessageId,
      processLanguage,
    );
    const isError = turn.status === 'failed';
    if (
      previousTurn?.status === turn.status &&
      previousTurn.processLanguage === processLanguage &&
      previousTurn.durationLabel === durationLabel &&
      previousTurn.model?.displayName === model?.displayName &&
      previousTurn.model?.wireApi === model?.wireApi &&
      previousTurn.messages === stableMessages &&
      previousTurn.pendingAgentOutputs === pendingAgentOutputs &&
      previousTurn.activities === activities &&
      previousTurn.workspaceRead === workspaceRead &&
      previousTurn.workspaceList === workspaceList &&
      previousTurn.workspaceSearch === workspaceSearch &&
      previousTurn.fileChange === fileChange &&
      previousTurn.commandApproval === commandApproval &&
      previousTurn.mcpActivities === mcpActivities &&
      previousTurn.terminalLabel === terminalLabel &&
      previousTurn.failure === failure &&
      previousTurn.isError === isError
    ) {
      return previousTurn;
    }
    return {
      id: turn.id,
      status: turn.status,
      processLanguage,
      ...(durationLabel ? { durationLabel } : {}),
      ...(model ? { model } : {}),
      messages: stableMessages,
      ...(pendingAgentOutputs ? { pendingAgentOutputs } : {}),
      ...(activities ? { activities } : {}),
      ...(workspaceRead ? { workspaceRead } : {}),
      ...(workspaceList ? { workspaceList } : {}),
      ...(workspaceSearch ? { workspaceSearch } : {}),
      ...(fileChange ? { fileChange } : {}),
      ...(commandApproval ? { commandApproval } : {}),
      ...(mcpActivities ? { mcpActivities } : {}),
      ...(terminalLabel ? { terminalLabel } : {}),
      ...(failure ? { failure } : {}),
      isError,
    };
  });
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

export const toThreadNavigatorViewModel = (
  snapshot: ConversationStateSnapshot,
): ThreadNavigatorViewModel => {
  const threadIds = snapshot.navigator.activeThreadIds;
  const statusLabel = (() => {
    if (snapshot.navigator.pendingThreadId) {
      return `Loading Thread ${snapshot.navigator.pendingThreadId}`;
    }
    if (snapshot.navigator.status === 'loading') {
      return 'Loading active Threads';
    }
    if (snapshot.navigator.status === 'unavailable') {
      return 'Thread navigation unavailable';
    }
    if (snapshot.navigator.status === 'error') {
      return 'Active Threads could not be loaded';
    }
    return `${threadIds.length} active Threads`;
  })();
  return {
    status: snapshot.navigator.status,
    threadIds,
    threadTitles: snapshot.navigator.activeThreadTitles,
    runningThreadIds: snapshot.navigator.runningThreadIds ?? [],
    unreadThreadStatuses: snapshot.navigator.unreadThreadStatuses ?? {},
    selectedThreadId: snapshot.threadId ?? null,
    pendingThreadId: snapshot.navigator.pendingThreadId ?? null,
    pendingMutation: snapshot.navigator.pendingMutation ?? null,
    archivedUndoThreadId: snapshot.navigator.archivedUndoThreadId ?? null,
    truncated: snapshot.navigator.activeTruncated,
    statusLabel,
    ...(snapshot.navigator.selectionNotice
      ? { selectionNotice: snapshot.navigator.selectionNotice }
      : {}),
    ...(snapshot.navigator.mutationNotice
      ? { mutationNotice: snapshot.navigator.mutationNotice }
      : {}),
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
  const transcriptContent = useRef<HTMLDivElement | null>(null);
  const transcriptEnd = useRef<HTMLDivElement | null>(null);
  const transcriptViewport = useRef<HTMLDivElement | null>(null);
  const shouldFollowTranscript = useRef<boolean>(true);
  const previousScrollTop = useRef<number>(0);
  const pointerScrollActive = useRef<boolean>(false);
  const previousThreadIdentity = useRef<string | null>(thread.threadIdentity);
  const latestUserMessageId = (() => {
    for (
      let turnIndex = thread.turns.length - 1;
      turnIndex >= 0;
      turnIndex -= 1
    ) {
      const messages = thread.turns[turnIndex]?.messages ?? [];
      for (
        let messageIndex = messages.length - 1;
        messageIndex >= 0;
        messageIndex -= 1
      ) {
        const entry = messages[messageIndex];
        if (entry?.role === 'user') {
          return entry.message.id;
        }
      }
    }
    return null;
  })();
  const previousUserMessageId = useRef<string | null>(latestUserMessageId);

  const scrollTranscriptToEnd = useCallback((): void => {
    if (!shouldFollowTranscript.current) {
      return;
    }
    const viewport = transcriptViewport.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
      previousScrollTop.current = viewport.scrollTop;
      return;
    }
    transcriptEnd.current?.scrollIntoView({ block: 'end' });
  }, []);

  const recordScrollPosition = (event: UIEvent<HTMLDivElement>): void => {
    const viewport = event.currentTarget;
    shouldFollowTranscript.current = shouldFollowTranscriptAfterScroll({
      wasFollowing: shouldFollowTranscript.current,
      previousScrollTop: previousScrollTop.current,
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      pointerScrollActive: pointerScrollActive.current,
    });
    previousScrollTop.current = viewport.scrollTop;
  };

  const recordWheelScrollIntent: TranscriptFollow['recordWheelScrollIntent'] = (
    event,
  ): void => {
    if (event.deltaY < 0) {
      shouldFollowTranscript.current = false;
    }
  };

  const recordKeyScrollIntent: TranscriptFollow['recordKeyScrollIntent'] = (
    event,
  ): void => {
    if (isTranscriptScrollUpKey(event.key, event.shiftKey)) {
      shouldFollowTranscript.current = false;
    }
  };

  const beginPointerScroll: TranscriptFollow['beginPointerScroll'] = (): void => {
    pointerScrollActive.current = true;
  };

  const endPointerScroll: TranscriptFollow['endPointerScroll'] = (): void => {
    pointerScrollActive.current = false;
  };

  useLayoutEffect(() => {
    const threadChanged =
      previousThreadIdentity.current !== thread.threadIdentity;
    const userMessageAdded =
      latestUserMessageId !== null &&
      previousUserMessageId.current !== latestUserMessageId;
    if (threadChanged || userMessageAdded) {
      shouldFollowTranscript.current = true;
    }
    previousThreadIdentity.current = thread.threadIdentity;
    previousUserMessageId.current = latestUserMessageId;

    if (shouldFollowTranscript.current) {
      scrollTranscriptToEnd();
      const animationFrame = requestAnimationFrame(scrollTranscriptToEnd);
      return () => cancelAnimationFrame(animationFrame);
    }
    return undefined;
  }, [
    latestUserMessageId,
    scrollTranscriptToEnd,
    thread.phase,
    thread.threadIdentity,
    thread.turns,
  ]);

  useEffect(() => {
    const content = transcriptContent.current;
    if (!content) {
      return undefined;
    }
    const observer = new ResizeObserver(scrollTranscriptToEnd);
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollTranscriptToEnd]);

  return {
    transcriptContent,
    transcriptEnd,
    transcriptViewport,
    recordScrollPosition,
    recordWheelScrollIntent,
    recordKeyScrollIntent,
    beginPointerScroll,
    endPointerScroll,
  };
};

export const useStore = (): ThreadStore => {
  const [snapshot, setSnapshot] =
    useState<ConversationStateSnapshot>(INITIAL_SNAPSHOT);
  const [draft, setDraft] = useState<string>('');
  const [attachments, setAttachments] = useState<DraftAttachmentViewModel[]>([]);
  const [expandedProjectIds, setExpandedProjectIds] =
    useState<readonly string[]>([]);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeQuietSeconds, setActiveQuietSeconds] = useState<number>(0);
  const activeProgressClock = useRef<{
    turnId: string;
    observedAt: number;
  } | null>(null);
  const [modelInspection, setModelInspection] =
    useState<Awaited<ReturnType<typeof getModelConfig>> | null>(null);
  const [selectedModelProfileId, setSelectedModelProfileId] =
    useState<string>('');
  const [pendingModelProfileId, setPendingModelProfileId] =
    useState<string | null>(null);
  const drafts = useRef(
    new Map<
      string,
      Readonly<{
        draft: string;
        attachments: DraftAttachmentViewModel[];
      }>
    >(),
  );
  const draftKey = useRef<string>('new');
  const modelSelections = useRef(new Map<string, string>());
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
    void getConversationState()
      .then(acceptSnapshot)
      .catch(() => {
        if (active) {
          setActionError('Desktop could not read the current conversation.');
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const refreshModelCatalog = (): void => {
      void getModelConfig()
        .then((inspection) => {
          if (active) {
            setModelInspection(inspection);
          }
        })
        .catch(() => {
          if (active) {
            setActionError('Desktop could not read the model catalog.');
          }
        });
    };
    refreshModelCatalog();
    window.addEventListener(
      MODEL_CONFIG_CHANGED_EVENT,
      refreshModelCatalog,
    );
    return () => {
      active = false;
      window.removeEventListener(
        MODEL_CONFIG_CHANGED_EVENT,
        refreshModelCatalog,
      );
    };
  }, []);

  useEffect(() => {
    const nextKey = snapshot.threadId ?? 'new';
    if (draftKey.current === nextKey) {
      return;
    }
    drafts.current.set(draftKey.current, { draft, attachments });
    const saved = drafts.current.get(nextKey);
    draftKey.current = nextKey;
    setDraft(saved?.draft ?? '');
    setAttachments(saved ? [...saved.attachments] : []);
    setPendingModelProfileId(null);
  }, [snapshot.threadId]);

  useEffect(() => {
    const catalog = modelInspection?.config;
    if (!catalog) {
      setSelectedModelProfileId('');
      return;
    }
    const key = snapshot.threadId ?? 'new';
    setSelectedModelProfileId(
      resolveModelProfileId(
        modelSelections.current.get(key),
        latestDurableModelProfileId(snapshot.turns),
        catalog.defaultProfileId,
      ),
    );
  }, [modelInspection, snapshot.threadId, snapshot.turns]);

  const selectModelProfile = (profileId: string): void => {
    if (profileId === selectedModelProfileId) {
      return;
    }
    if (snapshot.turns.length > 0) {
      setPendingModelProfileId(profileId);
      return;
    }
    modelSelections.current.set(snapshot.threadId ?? 'new', profileId);
    setSelectedModelProfileId(profileId);
  };

  const confirmModelSwitch = (): void => {
    if (!pendingModelProfileId) {
      return;
    }
    modelSelections.current.set(
      snapshot.threadId ?? 'new',
      pendingModelProfileId,
    );
    setSelectedModelProfileId(pendingModelProfileId);
    setPendingModelProfileId(null);
  };

  const cancelModelSwitch = (): void => setPendingModelProfileId(null);

  const toggleProjectExpanded = (projectId: string): void => {
    setExpandedProjectIds((current) =>
      current.includes(projectId)
        ? current.filter((candidate) => candidate !== projectId)
        : [...current, projectId],
    );
  };

  const bytes = inputBytes(draft);
  const attachmentBytes = attachments.reduce(
    (total, attachment) => total + attachment.sizeBytes,
    0,
  );
  const phaseAllowsSend =
    snapshot.phase === 'idle' || snapshot.phase === 'ready';
  const canSend =
    phaseAllowsSend &&
    !snapshot.navigator.pendingThreadId &&
    !snapshot.navigator.pendingMutation &&
    !isSending &&
    (draft.trim().length > 0 || attachments.length > 0) &&
    bytes <= MAX_CONVERSATION_INPUT_BYTES &&
    selectedModelProfileId.length > 0 &&
    Boolean(
      modelInspection?.config?.profiles.some(
        (profile) =>
          profile.id === selectedModelProfileId &&
          modelInspection.config?.connections.some(
            (connection) =>
              connection.id === profile.connectionId &&
              connection.enabled,
          ),
      ),
    );
  const canStop =
    snapshot.phase === 'inProgress' || snapshot.phase === 'stopping';

  const addAttachments = async (files: readonly File[]): Promise<void> => {
    setActionError(null);
    if (attachments.length + files.length > MAX_CONVERSATION_ATTACHMENTS) {
      setActionError('A Turn can include at most 10 attachments.');
      return;
    }
    const incomingBytes = files.reduce((total, file) => total + file.size, 0);
    if (
      attachmentBytes + incomingBytes >
      MAX_CONVERSATION_ATTACHMENT_BYTES
    ) {
      setActionError('Attachments exceed the 20 MiB Turn limit.');
      return;
    }
    try {
      const imported = await Promise.all(
        files.map(async (file): Promise<DraftAttachmentViewModel> => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          }
          const data = btoa(binary);
          return {
            id: crypto.randomUUID(),
            fileName: file.name,
            mediaType: file.type,
            sizeBytes: file.size,
            data,
            ...(file.type.startsWith('image/')
              ? { previewUrl: `data:${file.type};base64,${data}` }
              : {}),
          };
        }),
      );
      setAttachments((current) => [...current, ...imported]);
    } catch {
      setActionError('Desktop could not read one of these attachments.');
    }
  };

  const removeAttachment = (id: string): void => {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== id),
    );
  };

  const send = async (): Promise<void> => {
    if (!canSend) {
      return;
    }
    setIsSending(true);
    setActionError(null);
    try {
      const result = await sendConversationMessage({
        input: draft,
        ...(attachments.length > 0
          ? {
              attachments: attachments.map((attachment) => ({
                fileName: attachment.fileName,
                ...(attachment.mediaType
                  ? { mediaType: attachment.mediaType }
                  : {}),
                data: attachment.data,
              })),
            }
          : {}),
        modelProfileId: selectedModelProfileId,
      });
      if (result.accepted) {
        setDraft('');
        setAttachments([]);
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
      const result = await stopConversationTurn(snapshot.threadId as string);
      if (!result.accepted) {
        setActionError('The active Turn could not be stopped safely.');
      }
    } catch {
      setActionError('Desktop could not request a safe stop.');
    }
  };

  const selectThread = async (threadId: string): Promise<void> => {
    setActionError(null);
    try {
      const result = await selectConversationThread(threadId);
      if (!result.accepted && result.reason === 'turnActive') {
        setActionError('Stop the active Turn before switching Threads.');
      } else if (!result.accepted) {
        setActionError('That durable Thread could not be selected.');
      }
    } catch {
      setActionError('Desktop could not switch Threads safely.');
    }
  };

  const startNewThread = async (): Promise<void> => {
    setActionError(null);
    try {
      const result = await startNewConversationThread();
      if (result.accepted) {
        const defaultProfileId =
          modelInspection?.config?.defaultProfileId;
        if (defaultProfileId) {
          modelSelections.current.set('new', defaultProfileId);
          setSelectedModelProfileId(defaultProfileId);
        }
        return;
      }
      setActionError(
        result.reason === 'turnActive'
          ? 'Stop the active Turn before starting a new task.'
          : 'A new task could not be started right now.',
      );
    } catch {
      setActionError('Desktop could not start a new task safely.');
    }
  };

  const runThreadMutation = async (
    action: (threadId: string) => Promise<ConversationActionResult>,
    threadId: string,
    failure: string,
  ): Promise<void> => {
    setActionError(null);
    try {
      const result = await action(threadId);
      if (!result.accepted) {
        setActionError(
          result.reason === 'turnActive'
            ? 'Stop the active Turn before changing Thread lifecycle.'
            : failure,
        );
      }
    } catch {
      setActionError(failure);
    }
  };

  const forkThread = (threadId: string): Promise<void> =>
    runThreadMutation(
      forkConversationThread,
      threadId,
      'That durable Thread could not be forked safely.',
    );

  const archiveThread = (threadId: string): Promise<void> =>
    runThreadMutation(
      archiveConversationThread,
      threadId,
      'That durable Thread could not be archived safely.',
    );

  const unarchiveThread = (threadId: string): Promise<void> =>
    runThreadMutation(
      unarchiveConversationThread,
      threadId,
      'That archived Thread could not be restored safely.',
    );

  const deleteThread = (threadId: string): Promise<void> =>
    runThreadMutation(
      deleteConversationThread,
      threadId,
      'That durable Thread could not be deleted safely.',
    );

  const thread = useMemo<ThreadViewModel>(() => {
    const next = toThreadViewModel(snapshot, previousThread.current);
    previousThread.current = next;
    return next;
  }, [snapshot]);
  const activeTurnSnapshot = snapshot.activeTurnId
    ? snapshot.turns.find((turn) => turn.id === snapshot.activeTurnId)
    : undefined;
  const activeTurnView = snapshot.activeTurnId
    ? thread.turns.find((turn) => turn.id === snapshot.activeTurnId)
    : undefined;
  const activeUsageKey = activeTurnSnapshot?.usage
    ? JSON.stringify(activeTurnSnapshot.usage)
    : '';

  useEffect(() => {
    const turnId = activeTurnView?.id;
    if (!turnId || snapshot.phase !== 'inProgress') {
      activeProgressClock.current = null;
      setActiveQuietSeconds(0);
      return;
    }
    activeProgressClock.current = {
      turnId,
      observedAt: window.performance.now(),
    };
    setActiveQuietSeconds(0);
    const updateElapsed = (): void => {
      const clock = activeProgressClock.current;
      if (!clock || clock.turnId !== turnId) {
        return;
      }
      setActiveQuietSeconds(
        Math.max(
          0,
          Math.floor((window.performance.now() - clock.observedAt) / 1_000),
        ),
      );
    };
    const interval = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(interval);
  }, [activeTurnView, activeUsageKey, snapshot.phase]);
  const inputHint =
    bytes > MAX_CONVERSATION_INPUT_BYTES
      ? 'Message exceeds the 64 KiB limit'
      : attachments.length > 0
        ? `${attachments.length} attachment${attachments.length === 1 ? '' : 's'} · ${Math.ceil(attachmentBytes / 1024)} KiB`
        : `${Math.ceil(bytes / 1024)} / 64 KiB`;
  const latestUsage = latestTurnUsage(snapshot.turns);
  const contextBudgetHint = latestUsage
    ? formatTokenUsageHint(latestUsage)
    : null;
  const navigator = useMemo(
    () => toThreadNavigatorViewModel(snapshot),
    [snapshot],
  );
  const modelOptions = useMemo(() => {
    const catalog = modelInspection?.config;
    const available = (catalog?.profiles ?? []).map((profile) => {
      const connection = catalog?.connections.find(
        (candidate) => candidate.id === profile.connectionId,
      );
      return {
        profileId: profile.id,
        label: `${profile.displayName} · ${
          connection?.displayName ?? 'Unavailable'
        }`,
        available: connection?.enabled === true,
      };
    });
    if (
      selectedModelProfileId &&
      !available.some(
        (option) => option.profileId === selectedModelProfileId,
      )
    ) {
      available.push({
        profileId: selectedModelProfileId,
        label: `${selectedModelProfileId} · unavailable`,
        available: false,
      });
    }
    return available;
  }, [modelInspection, selectedModelProfileId]);
  const modelSwitchConfirmation = useMemo(() => {
    const catalog = modelInspection?.config;
    if (!catalog || !pendingModelProfileId) {
      return null;
    }
    const profileDetails = (profileId: string) => {
      const profile = catalog.profiles.find(
        (candidate) => candidate.id === profileId,
      );
      const connection = catalog.connections.find(
        (candidate) => candidate.id === profile?.connectionId,
      );
      return {
        name: profile?.displayName ?? profileId,
        wireApi: connection?.wireApi ?? 'unavailable',
      };
    };
    const source = profileDetails(selectedModelProfileId);
    const target = profileDetails(pendingModelProfileId);
    return {
      sourceName: source.name,
      sourceWireApi: source.wireApi,
      targetName: target.name,
      targetWireApi: target.wireApi,
      protocolChanges: source.wireApi !== target.wireApi,
    };
  }, [modelInspection, pendingModelProfileId, selectedModelProfileId]);
  const activeTurnProgress = activeTurnView
    ? toActiveTurnProgress(
        activeTurnView.id,
        activeTurnView.model?.displayName,
        snapshot.phase,
        activeQuietSeconds,
      )
    : null;

  return {
    thread,
    navigator,
    expandedProjectIds,
    draft,
    attachments,
    inputBytes: bytes,
    inputLimitBytes: MAX_CONVERSATION_INPUT_BYTES,
    inputHint,
    contextBudgetHint,
    canSend,
    canStop,
    activeTurnProgress,
    isSending,
    actionError,
    modelOptions,
    selectedModelProfileId,
    modelSelectionDisabled:
      snapshot.phase === 'starting' ||
      snapshot.phase === 'inProgress' ||
      snapshot.phase === 'stopping' ||
      isSending,
    modelSwitchConfirmation,
    setDraft,
    addAttachments,
    removeAttachment,
    toggleProjectExpanded,
    setSelectedModelProfileId: selectModelProfile,
    confirmModelSwitch,
    cancelModelSwitch,
    startNewThread,
    selectThread,
    forkThread,
    archiveThread,
    unarchiveThread,
    deleteThread,
    send,
    stop,
  };
};
