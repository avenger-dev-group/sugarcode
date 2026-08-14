import {
  type UIEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useStore as useZustandStore } from 'zustand';

import {
  deleteConversationThread,
  respondToConversationUserInput,
  sendConversationMessage,
  startNewConversationThread,
  stopConversationTurn,
} from '@/renderer/services/conversation';
import {
  getModelConfig,
  MODEL_CONFIG_CHANGED_EVENT,
} from '@/renderer/services/model-config';
import {
  activateWorkspaceChat,
  focusWorkspaceTask,
  getWorkspaceState,
  renameWorkspaceTask,
} from '@/renderer/services/workspace';
import {
  acceptForegroundCommit,
  beginConversationSelection,
  conversationProjectionStore,
  failConversationSelection,
} from '@/renderer/stores/conversation-projection-store';
import {
  acceptWorkspaceSnapshot,
  workspaceProjectionStore,
} from '@/renderer/stores/workspace-projection-store';
import {
  MAX_CONVERSATION_ATTACHMENTS,
  MAX_CONVERSATION_ATTACHMENT_BYTES,
  isValidConversationTitle,
  type ConversationActionResult,
  type ConversationMessageStatus,
  type ConversationCommandApprovalActivity,
  type ConversationMcpActivity,
  type ConversationPhase,
  type ConversationSkillActivity,
  type ConversationStateSnapshot,
  type ConversationThreadNavigatorSnapshot,
  type ConversationTurnStatus,
  type ConversationWorkspaceListActivity,
  type ConversationWorkspaceReadActivity,
  type ConversationWorkspaceSearchActivity,
} from '@/shared/conversation';
import { parseComposerSubmission } from '@/shared/composer';

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
import type { UserInputSubmission } from '../user-input/types';
import type {
  ActivityDisclosureStore,
  ThreadStore,
  ThreadNavigatorViewModel,
  ThreadViewModel,
  DraftAttachmentViewModel,
  SkillActivityPresentationState,
  TranscriptFollow,
  TranscriptMessageViewModel,
  TurnViewModel,
} from './types';
import {
  latestDurableModelProfileId,
  resolveModelProfileId,
} from './model-selection';
import { useMessageEditor } from './use-message-editor';
import {
  canStartConversationTurn,
  canStopTurn,
  shouldShowStopControl,
  shouldStartChatOnSend,
  TURN_STOP_SAFETY_DELAY_MS,
} from './composer-state';
import {
  isTranscriptScrollUpKey,
  shouldFollowTranscriptAfterScroll,
  shouldHoldTranscriptPlaceholder,
  shouldResetTranscriptFollow,
} from './transcript-follow';
import {
  completedProcessDurationLabel,
  processLanguageFromText,
} from './activity-disclosure';
import { toTurnFailureViewModel } from './turn-failure';
import {
  activeTurnOperationProgress,
  toActiveTurnProgress,
} from './turn-progress';
import { collectTurnVerifiedFilePaths } from './verified-file-paths';

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

const commandOperationKind = (
  activity: ConversationCommandApprovalActivity,
): CommandApprovalActivityViewModel['operationKind'] =>
  activity.operationKind === 'workspacePatch' ||
  activity.command.startsWith('workspace_apply_patch') ||
  activity.executionResult?.outcome.type === 'workspacePatch'
    ? 'workspacePatch'
    : 'shell';

const commandDisplaySummary = (
  activity: ConversationCommandApprovalActivity,
): string => {
  if (!activity.command.startsWith('workspace_apply_patch')) {
    return activity.command;
  }
  const filesChanged =
    activity.executionResult?.outcome.type === 'workspacePatch'
      ? activity.executionResult.outcome.filesChanged
      : undefined;
  return filesChanged === undefined
    ? 'Workspace file changes'
    : `${filesChanged} workspace file ${filesChanged === 1 ? 'change' : 'changes'}`;
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

const toSkillPresentationState = (
  phase: ConversationPhase,
  turnStatus: ConversationTurnStatus,
  activity: ConversationSkillActivity,
): SkillActivityPresentationState => {
  if (activity.result?.status === 'completed') {
    return activity.result.outcome.type === 'success' ? 'succeeded' : 'failed';
  }
  if (turnStatus === 'interrupted') {
    return 'interrupted';
  }
  if (turnStatus !== 'inProgress') {
    throw new Error('A terminal Skill activity has no durable result.');
  }
  switch (phase) {
    case 'inProgress':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'unavailable':
      return 'uncertain';
    default:
      throw new Error('Skill activity did not match its Turn phase.');
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
    const nextVerifiedFilePaths = collectTurnVerifiedFilePaths(turn);
    const verifiedFilePaths =
      JSON.stringify(previousTurn?.verifiedFilePaths) ===
      JSON.stringify(nextVerifiedFilePaths)
        ? previousTurn?.verifiedFilePaths ?? nextVerifiedFilePaths
        : nextVerifiedFilePaths;
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
          const submission = parseComposerSubmission(message.text);
          if (
            previousMessage?.role === 'user' &&
            previousMessage.message.text === submission.text &&
            JSON.stringify(previousMessage.message.references) ===
              JSON.stringify(submission.references) &&
            JSON.stringify(previousMessage.message.attachments) ===
              JSON.stringify(message.attachments ?? [])
          ) {
            return previousMessage;
          }
          return {
            role: 'user',
            message: {
              id: message.id,
              text: submission.text,
              references: submission.references,
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
          previousMessage.message.state === state &&
          previousMessage.message.verifiedFilePaths === verifiedFilePaths
        ) {
          return previousMessage;
        }
        return {
          role: 'agent',
          message: {
            id: message.id,
            text: message.text,
            state,
            verifiedFilePaths,
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
      verifiedFilePaths,
    }));
    const pendingAgentOutputs =
      JSON.stringify(previousTurn?.pendingAgentOutputs) ===
      JSON.stringify(nextPendingAgentOutputs)
        ? previousTurn?.pendingAgentOutputs
        : nextPendingAgentOutputs;
    const nextUserInputRequest = turn.userInputRequest
      ? {
          id: turn.userInputRequest.id,
          questions: turn.userInputRequest.questions.map((question) => ({
            id: question.id,
            header: question.header,
            question: question.question,
            options: question.options.map((option) => ({
              label: option.label,
              description: option.description,
            })),
          })),
        }
      : undefined;
    const userInputRequest =
      JSON.stringify(previousTurn?.userInputRequest) ===
      JSON.stringify(nextUserInputRequest)
        ? previousTurn?.userInputRequest
        : nextUserInputRequest;
    const planProposal =
      turn.planProposal &&
        previousTurn?.planProposal?.id === turn.planProposal.id &&
        previousTurn.planProposal.content === turn.planProposal.content
        ? previousTurn.planProposal
        : turn.planProposal;
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
          operationKind: commandOperationKind(turn.commandApproval),
          command: commandDisplaySummary(turn.commandApproval),
          argumentCount: turn.commandApproval.argumentCount,
          ...(turn.commandApproval.fullAccess
            ? { fullAccess: true }
            : {}),
          ...(turn.commandApproval.decision?.source
            ? { approvalSource: turn.commandApproval.decision.source }
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
      previousTurn.commandApproval.operationKind ===
        nextCommandApproval.operationKind &&
      previousTurn.commandApproval.command === nextCommandApproval.command &&
      previousTurn.commandApproval.argumentCount ===
        nextCommandApproval.argumentCount &&
      previousTurn.commandApproval.fullAccess === nextCommandApproval.fullAccess &&
      previousTurn.commandApproval.approvalSource ===
        nextCommandApproval.approvalSource &&
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
        case 'skill': {
          const outcome = entry.activity.result?.outcome;
          return {
            type: entry.type,
            activity: {
              id: entry.activity.id,
              name: entry.activity.name,
              state: toSkillPresentationState(
                snapshot.phase,
                turn.status,
                entry.activity,
              ),
              ...(outcome?.type === 'success' && outcome.purpose
                ? { purpose: outcome.purpose }
                : entry.activity.purpose
                  ? { purpose: entry.activity.purpose }
                  : {}),
              ...(outcome?.type === 'success' && outcome.description
                ? { description: outcome.description }
                : {}),
              ...(outcome?.type === 'success' && outcome.content
                ? { content: outcome.content }
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
              operationKind: commandOperationKind(entry.activity),
              command: commandDisplaySummary(entry.activity),
              argumentCount: entry.activity.argumentCount,
              ...(entry.activity.fullAccess ? { fullAccess: true } : {}),
              ...(entry.activity.liveOutput
                ? { liveOutput: { ...entry.activity.liveOutput } }
                : {}),
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
        case 'contextCompaction':
          return {
            type: entry.type,
            activity: {
              id: entry.activity.id,
              state: entry.activity.status === 'inProgress'
                ? ('running' as const)
                : entry.activity.status,
              trigger: entry.activity.trigger,
              strategy: entry.activity.strategy,
              ...(entry.activity.beforeContextTokens === undefined
                ? {}
                : { beforeContextTokens: entry.activity.beforeContextTokens }),
              ...(entry.activity.afterContextTokens === undefined
                ? {}
                : { afterContextTokens: entry.activity.afterContextTokens }),
              ...(entry.activity.durationMs === undefined
                ? {}
                : { durationMs: entry.activity.durationMs }),
              ...(entry.activity.readableSummary === undefined
                ? {}
                : { readableSummary: entry.activity.readableSummary }),
              ...(entry.activity.opaqueCheckpoint === undefined
                ? {}
                : { opaqueCheckpoint: entry.activity.opaqueCheckpoint }),
              ...(entry.activity.message === undefined
                ? {}
                : { message: entry.activity.message }),
            },
          } as const;
        case 'userInput':
          return {
            type: entry.type,
            activity: {
              id: entry.activity.id,
              state: entry.activity.state,
              questions: entry.activity.questions.map((question) => ({
                id: question.id,
                header: question.header,
                question: question.question,
                options: question.options.map((option) => ({ ...option })),
              })),
              decisions: entry.activity.decisions.map((decision) => ({
                ...decision,
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
      ? toTurnFailureViewModel(turn.error, model?.wireApi, processLanguage)
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
      previousTurn.verifiedFilePaths === verifiedFilePaths &&
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
      previousTurn.userInputRequest === userInputRequest &&
      previousTurn.planProposal === planProposal &&
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
      verifiedFilePaths,
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
      ...(userInputRequest
        ? { userInputRequest }
        : {}),
      ...(planProposal ? { planProposal } : {}),
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

  return {
    phase: snapshot.phase,
    workspaceIdentity: snapshot.workspaceId ?? null,
    threadIdentity: snapshot.threadId ?? null,
    turns: stableTurns,
    isEmpty: stableTurns.length === 0,
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
    inputRequiredThreadIds: snapshot.navigator.inputRequiredThreadIds ?? [],
    unreadThreadStatuses: snapshot.navigator.unreadThreadStatuses ?? {},
    selectedThreadId: snapshot.threadId ?? null,
    pendingThreadId: snapshot.navigator.pendingThreadId ?? null,
    pendingMutation: snapshot.navigator.pendingMutation ?? null,
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

export const useTranscriptFollow = (
  thread: ThreadViewModel,
  pendingThreadId: string | null,
): TranscriptFollow => {
  const transcriptContent = useRef<HTMLDivElement | null>(null);
  const transcriptEnd = useRef<HTMLDivElement | null>(null);
  const transcriptViewport = useRef<HTMLDivElement | null>(null);
  const shouldFollowTranscript = useRef<boolean>(true);
  const previousScrollTop = useRef<number>(0);
  const pointerScrollActive = useRef<boolean>(false);
  const previousThreadIdentity = useRef<string | null>(thread.threadIdentity);
  const previousPendingThreadId = useRef<string | null>(pendingThreadId);
  const deferredThreadIdentity = useDeferredValue(thread.threadIdentity);
  const settlingThreadSelection = shouldHoldTranscriptPlaceholder({
    deferredThreadId: deferredThreadIdentity,
    pendingThreadId,
    previousPendingThreadId: previousPendingThreadId.current,
    threadId: thread.threadIdentity,
  });
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
    if (settlingThreadSelection) {
      return undefined;
    }
    const userMessageAdded =
      latestUserMessageId !== null &&
      previousUserMessageId.current !== latestUserMessageId;
    if (shouldResetTranscriptFollow({
      previousThreadId: previousThreadIdentity.current,
      threadId: thread.threadIdentity,
      previousPendingThreadId: previousPendingThreadId.current,
      pendingThreadId,
      userMessageAdded,
    })) {
      shouldFollowTranscript.current = true;
    }
    previousThreadIdentity.current = thread.threadIdentity;
    previousPendingThreadId.current = pendingThreadId;
    previousUserMessageId.current = latestUserMessageId;

    if (shouldFollowTranscript.current) {
      scrollTranscriptToEnd();
      let secondAnimationFrame = 0;
      const firstAnimationFrame = requestAnimationFrame(() => {
        scrollTranscriptToEnd();
        secondAnimationFrame = requestAnimationFrame(scrollTranscriptToEnd);
      });
      return () => {
        cancelAnimationFrame(firstAnimationFrame);
        cancelAnimationFrame(secondAnimationFrame);
      };
    }
    return undefined;
  }, [
    latestUserMessageId,
    pendingThreadId,
    scrollTranscriptToEnd,
    settlingThreadSelection,
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
    settlingThreadSelection,
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
  const snapshot = useZustandStore(
    conversationProjectionStore,
    (projection) => projection.snapshot,
  );
  const projectionError = useZustandStore(
    conversationProjectionStore,
    (projection) => projection.loadError,
  );
  const workspaceSnapshot = useZustandStore(
    workspaceProjectionStore,
    (projection) => projection.snapshot,
  );
  const [draft, setDraft] = useState<string>('');
  const [attachments, setAttachments] = useState<DraftAttachmentViewModel[]>([]);
  const [expandedProjectIds, setExpandedProjectIds] =
    useState<readonly string[]>([]);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [stopUnlockedTurnId, setStopUnlockedTurnId] =
    useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [renameRequest, setRenameRequest] = useState<Readonly<{
    threadId: string;
    title: string;
  }> | null>(null);
  const [renameDraft, setRenameDraftState] = useState<string>('');
  const [renamePending, setRenamePending] = useState<boolean>(false);
  const [renameError, setRenameError] = useState<string | null>(null);
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
  const sendInFlight = useRef(false);
  const previousThread = useRef<ThreadViewModel | undefined>(undefined);
  const thread = useMemo<ThreadViewModel>(() => {
    const next = toThreadViewModel(snapshot, previousThread.current);
    previousThread.current = next;
    return next;
  }, [snapshot]);
  const messageEditing = useMessageEditor({
    threadId: snapshot.threadId,
    turns: snapshot.turns,
    thread,
    phase: snapshot.phase,
    isSending,
    selectedModelProfileId,
  });

  useEffect(() => {
    const turnId = snapshot.activeTurnId;
    if (snapshot.phase !== 'inProgress' || !turnId) {
      setStopUnlockedTurnId(null);
      return;
    }
    setStopUnlockedTurnId(null);
    const timer = window.setTimeout(() => {
      setStopUnlockedTurnId(turnId);
    }, TURN_STOP_SAFETY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [snapshot.activeTurnId, snapshot.phase]);

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
    setActionError(null);
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

  const attachmentBytes = attachments.reduce(
    (total, attachment) => total + attachment.sizeBytes,
    0,
  );
  const startsChatOnSend = shouldStartChatOnSend(workspaceSnapshot);
  const hasUsableSelectedModel =
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
  const canStartTurn = canStartConversationTurn({
    phase: snapshot.phase,
    startsChatOnSend,
    hasPendingThreadSelection: Boolean(snapshot.navigator.pendingThreadId),
    hasPendingMutation: Boolean(snapshot.navigator.pendingMutation),
    isSending,
    isEditingMessage: messageEditing.active,
    hasUsableModel: hasUsableSelectedModel,
  });
  const canSend =
    canStartTurn &&
    (draft.trim().length > 0 || attachments.length > 0);
  const showStopControl = shouldShowStopControl(snapshot.phase, isSending);
  const canStop = canStopTurn(
    snapshot.phase,
    snapshot.activeTurnId,
    stopUnlockedTurnId,
  );

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
    if (!canSend || sendInFlight.current) {
      return;
    }
    sendInFlight.current = true;
    setIsSending(true);
    setActionError(null);
    try {
      if (startsChatOnSend) {
        const activation = await activateWorkspaceChat();
        if (!activation.accepted) {
          setActionError(
            activation.reason === 'busy'
              ? '正在切换会话，请稍后重试。'
              : '无法开始聊天，请重试。',
          );
          return;
        }
        if (activation.commit) {
          acceptWorkspaceSnapshot(activation.commit.workspace);
          acceptForegroundCommit(activation.commit);
        } else {
          await getWorkspaceState()
            .then(acceptWorkspaceSnapshot)
            .catch((): undefined => undefined);
        }
      }
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
            ? '消息内容无效，请调整后重试。'
            : 'The local Agent is not ready for another Turn.',
        );
      }
    } catch {
      setActionError('Desktop could not send this message safely.');
    } finally {
      sendInFlight.current = false;
      setIsSending(false);
    }
  };

  const stop = async (): Promise<void> => {
    if (!canStop) {
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

  const respondToUserInput = async (
    turnId: string,
    inputRequestId: string,
    submission: UserInputSubmission,
  ): Promise<boolean> => {
    if (!snapshot.threadId) {
      return false;
    }
    setActionError(null);
    try {
      const result = await respondToConversationUserInput({
        threadId: snapshot.threadId,
        turnId,
        inputRequestId,
        submission,
      });
      if (!result.accepted) {
        setActionError('Agent 已不再等待这组回答，请检查当前任务状态。');
      }
      return result.accepted;
    } catch {
      setActionError('回答未能安全提交，请重试。');
      return false;
    }
  };

  const implementPlan = async (turnId: string): Promise<void> => {
    const latestTurn = snapshot.turns.at(-1);
    if (
      !canStartTurn ||
      sendInFlight.current ||
      latestTurn?.id !== turnId ||
      !latestTurn.planProposal
    ) {
      setActionError('该计划当前无法开始实施。');
      return;
    }
    sendInFlight.current = true;
    setIsSending(true);
    setActionError(null);
    try {
      const result = await sendConversationMessage({
        input: '实施此计划',
        modelProfileId: selectedModelProfileId,
      });
      if (!result.accepted) {
        setActionError('无法开始实施该计划，请重试。');
      }
    } catch {
      setActionError('无法开始实施该计划，请重试。');
    } finally {
      sendInFlight.current = false;
      setIsSending(false);
    }
  };

  const refinePlan = (turnId: string): void => {
    const latestTurn = snapshot.turns.at(-1);
    if (latestTurn?.id !== turnId || !latestTurn.planProposal) {
      setActionError('只能继续完善最新的计划。');
      return;
    }
    setActionError(null);
    setDraft('/plan\n\n请继续完善上一轮计划：');
  };

  const selectThread = async (threadId: string): Promise<void> => {
    setActionError(null);
    beginConversationSelection(threadId);
    try {
      const result = await focusWorkspaceTask(threadId);
      if (result.accepted && result.commit) {
        acceptWorkspaceSnapshot(result.commit.workspace);
        acceptForegroundCommit(result.commit);
      } else if (!result.accepted && result.reason === 'busy') {
        failConversationSelection(
          threadId,
          'Stop the active Turn before switching Threads.',
        );
      } else if (!result.accepted) {
        failConversationSelection(
          threadId,
          'That durable Thread could not be selected. Select it to retry.',
        );
      }
    } catch {
      failConversationSelection(
        threadId,
        'Desktop could not switch Threads safely. Select it to retry.',
      );
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

  const deleteThread = (threadId: string): Promise<void> =>
    runThreadMutation(
      deleteConversationThread,
      threadId,
      'That durable Thread could not be deleted safely.',
    );

  const persistThreadRename = async (
    threadId: string,
    title: string,
  ): Promise<boolean> => {
    setActionError(null);
    try {
      const result = await renameWorkspaceTask({ threadId, title });
      if (result.accepted) {
        return true;
      }
      setActionError('That conversation could not be renamed.');
      return false;
    } catch {
      setActionError('Desktop could not rename that conversation safely.');
      return false;
    }
  };

  const requestThreadRename = (threadId: string, title: string): void => {
    setRenameRequest({ threadId, title });
    setRenameDraftState(title);
    setRenameError(null);
  };

  const setRenameDraft = (title: string): void => {
    setRenameDraftState(title);
    setRenameError(null);
  };

  const cancelThreadRename = (): void => {
    if (renamePending) {
      return;
    }
    setRenameRequest(null);
    setRenameDraftState('');
    setRenameError(null);
  };

  const confirmThreadRename = async (): Promise<void> => {
    if (!renameRequest || renamePending) {
      return;
    }
    const title = renameDraft.trim();
    if (!isValidConversationTitle(title)) {
      setRenameError('请输入不超过 80 个字符的有效名称。');
      return;
    }
    setRenamePending(true);
    setRenameError(null);
    if (await persistThreadRename(renameRequest.threadId, title)) {
      setRenameRequest(null);
      setRenameDraftState('');
    } else {
      setRenameError('无法重命名这个对话，请稍后重试。');
    }
    setRenamePending(false);
  };

  const activeTurnView = snapshot.activeTurnId
    ? thread.turns.find((turn) => turn.id === snapshot.activeTurnId)
    : undefined;
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
        label: profile.displayName,
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
        label: '当前模型不可用',
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
    const profileName = (profileId: string): string => {
      const profile = catalog.profiles.find(
        (candidate) => candidate.id === profileId,
      );
      return profile?.displayName ?? profileId;
    };
    return {
      sourceName: profileName(selectedModelProfileId),
      targetName: profileName(pendingModelProfileId),
    };
  }, [modelInspection, pendingModelProfileId, selectedModelProfileId]);
  const activeTurnProgress = activeTurnView
    ? toActiveTurnProgress(
        activeTurnView.id,
        snapshot.phase,
        activeTurnOperationProgress(activeTurnView),
        activeTurnView.pendingAgentOutputs?.length
          ? 'composing'
          : activeTurnView.activities?.length
            ? 'continuing'
            : 'thinking',
      )
    : null;

  return {
    thread,
    navigator,
    expandedProjectIds,
    workspaceGeneration: workspaceSnapshot.generation,
    workspaceReady: workspaceSnapshot.status === 'ready',
    draft,
    attachments,
    canSend,
    canStop,
    showStopControl,
    startsChatOnSend,
    activeTurnProgress,
    isSending,
    actionError: actionError ?? projectionError,
    editableMessageTarget: messageEditing.editableMessageTarget,
    messageEditor: messageEditing.messageEditor,
    rename: {
      request: renameRequest,
      draft: renameDraft,
      pending: renamePending,
      error: renameError,
      canSave:
        isValidConversationTitle(renameDraft.trim()) &&
        renameDraft.trim() !== renameRequest?.title,
    },
    modelOptions,
    selectedModelProfileId,
    modelSelectionDisabled:
      snapshot.phase === 'starting' ||
      snapshot.phase === 'inProgress' ||
      snapshot.phase === 'stopping' ||
      isSending ||
      messageEditing.active,
    modelSwitchConfirmation,
    setDraft,
    beginMessageEdit: messageEditing.beginMessageEdit,
    setMessageEditDraft: messageEditing.setMessageEditDraft,
    cancelMessageEdit: messageEditing.cancelMessageEdit,
    submitMessageEdit: messageEditing.submitMessageEdit,
    addAttachments,
    removeAttachment,
    toggleProjectExpanded,
    setSelectedModelProfileId: selectModelProfile,
    confirmModelSwitch,
    cancelModelSwitch,
    startNewThread,
    selectThread,
    deleteThread,
    requestThreadRename,
    setRenameDraft,
    cancelThreadRename,
    confirmThreadRename,
    send,
    stop,
    respondToUserInput,
    implementPlan,
    refinePlan,
  };
};
