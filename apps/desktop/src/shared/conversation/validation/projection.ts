import { MAX_THREAD_SEARCH_BYTES } from '../limits.ts';
import type {
  ConversationCommandApprovalActivity,
  ConversationFileChangeActivity,
  ConversationMcpActivity,
  ConversationPhase,
  ConversationTokenUsage,
  ConversationTurnStatus,
  ConversationTerminalTurnStatus,
  ConversationWorkspaceListActivity,
  ConversationWorkspaceReadActivity,
  ConversationWorkspaceSearchActivity,
} from '../activities.ts';
import type {
  ConversationNotice,
  ConversationStateSnapshot,
  ConversationThreadNavigatorSnapshot,
  ConversationThreadProjectionDelta,
  ConversationThreadProjectionSnapshot,
  ConversationThreadQueue,
  ConversationTurn,
} from '../projection.ts';
import {
  isCommandApprovalActivity,
  isConversationAttachment,
  isFileChangeActivity,
  isMcpActivity,
  isKnowledgeActivity,
  isMessage,
  isTurnError,
  isUserInputRequest,
  isWorkspaceListActivity,
  isWorkspaceReadActivity,
  isWorkspaceSearchActivity,
} from './activities.ts';
import { isId, isRecord } from './primitives.ts';
import { isModelRequestOptions } from '../../model-config.ts';

const PHASES = new Set<ConversationPhase>([
  'idle',
  'starting',
  'inProgress',
  'stopping',
  'ready',
  'unavailable',
]);

const TURN_STATUSES = new Set<ConversationTurnStatus>([
  'inProgress',
  'completed',
  'failed',
  'interrupted',
]);

const isThreadQueue = (value: unknown): value is ConversationThreadQueue => {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) => ['paused', 'messages'].includes(key)) ||
    typeof value.paused !== 'boolean' ||
    !Array.isArray(value.messages) ||
    value.messages.length > 10
  ) {
    return false;
  }
  const messages = value.messages;
  return messages.every(
    (message, index) =>
      isRecord(message) &&
      Object.keys(message).every((key) =>
        [
          'id',
          'position',
          'revision',
          'input',
          'attachments',
          'modelProfileId',
          'modelRequest',
          'createdAt',
          'updatedAt',
        ].includes(key),
      ) &&
      isId(message.id) &&
      Number.isSafeInteger(message.position) &&
      Number(message.position) >= 1 &&
      (index === 0 ||
        (isRecord(messages[index - 1]) &&
          Number(messages[index - 1]?.position) < Number(message.position))) &&
      Number.isSafeInteger(message.revision) &&
      Number(message.revision) >= 1 &&
      typeof message.input === 'string' &&
      Array.isArray(message.attachments) &&
      message.attachments.every(isConversationAttachment) &&
      (message.modelProfileId === undefined || isId(message.modelProfileId)) &&
      (message.modelRequest === undefined ||
        isModelRequestOptions(message.modelRequest)) &&
      Number.isSafeInteger(message.createdAt) &&
      Number.isSafeInteger(message.updatedAt),
  );
};

const TERMINAL_TURN_STATUSES = new Set<ConversationTerminalTurnStatus>([
  'completed',
  'failed',
  'interrupted',
]);

const isTokenUsage = (value: unknown): value is ConversationTokenUsage => {
  const isSample = (sample: unknown): boolean =>
    isRecord(sample) &&
    Object.values(sample).every(
      (token) => Number.isSafeInteger(token) && (token as number) >= 0,
    );
  return (
    isRecord(value) &&
    isSample(value.lastRequest) &&
    isSample(value.turnTotal) &&
    Number.isSafeInteger(value.requestCount) &&
    (value.requestCount as number) >= 1 &&
    Number.isInteger(value.contextWindowTokens) &&
    (value.contextWindowTokens as number) >= 4_096 &&
    (value.contextWindowTokens as number) <= 2_097_152 &&
    (value.source === 'provider' || value.source === 'estimated')
  );
};
const isTurn = (value: unknown): value is ConversationTurn => {
  const pendingAgentOutputs = isRecord(value)
    ? value.pendingAgentOutputs
    : undefined;
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    typeof value.status !== 'string' ||
    !TURN_STATUSES.has(value.status as ConversationTurnStatus) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isMessage) ||
    (Object.hasOwn(value, 'model') &&
      (!isRecord(value.model) ||
        !/^[A-Za-z0-9_-]{1,64}$/u.test(
          value.model.profileId as string,
        ) ||
        ![
          'openai',
          'anthropic',
        ].includes(value.model.providerFamily as string) ||
        ![
          'openaiResponses',
          'openaiChatCompletions',
          'anthropicMessages',
        ].includes(value.model.wireApi as string) ||
        typeof value.model.modelId !== 'string' ||
        typeof value.model.displayName !== 'string' ||
        !Number.isInteger(value.model.contextWindowTokens) ||
        (value.model.contextWindowTokens as number) < 4_096 ||
        (value.model.reasoningEffort !== undefined &&
          !isModelRequestOptions({
            reasoningEffort: value.model.reasoningEffort,
          })) ||
        (value.model.serviceTier !== undefined &&
          !isModelRequestOptions({ serviceTier: value.model.serviceTier })) ||
        !isRecord(value.model.effectiveCapabilities) ||
        ![
          'toolCalls',
          'strictTools',
          'parallelTools',
          'imageInput',
          'pdfInput',
        ].every(
          (key) =>
            typeof (
              (value.model as Record<string, unknown>)
                .effectiveCapabilities as Record<string, unknown>
            )[key] === 'boolean',
        ))) ||
    (Object.hasOwn(value, 'pendingAgentOutputs') &&
      (!Array.isArray(pendingAgentOutputs) ||
        pendingAgentOutputs.length > 1 ||
        !pendingAgentOutputs.every(
          (output) =>
            isRecord(output) &&
            Number.isSafeInteger(output.responseOrdinal) &&
            (output.responseOrdinal as number) >= 1 &&
            Number.isSafeInteger(output.outputIndex) &&
            (output.outputIndex as number) >= 0 &&
            typeof output.text === 'string' &&
            output.text.length > 0 &&
            new TextEncoder().encode(output.text).byteLength <= 512 * 1024,
        ))) ||
    (Object.hasOwn(value, 'activities') &&
      (!Array.isArray(value.activities) ||
        value.activities.length > 1_024 ||
        value.activities.some(
          (entry) =>
            isRecord(entry) &&
            entry.type === 'knowledge' &&
            !isKnowledgeActivity(entry.activity),
        ))) ||
    (Object.hasOwn(value, 'workspaceRead') &&
      !isWorkspaceReadActivity(value.workspaceRead)) ||
    (Object.hasOwn(value, 'workspaceList') &&
      !isWorkspaceListActivity(value.workspaceList)) ||
    (Object.hasOwn(value, 'workspaceSearch') &&
      !isWorkspaceSearchActivity(value.workspaceSearch)) ||
    (Object.hasOwn(value, 'fileChange') &&
      !isFileChangeActivity(value.fileChange)) ||
    (Object.hasOwn(value, 'commandApproval') &&
      !isCommandApprovalActivity(value.commandApproval)) ||
    (Object.hasOwn(value, 'mcpActivities') &&
      (!Array.isArray(value.mcpActivities) ||
        value.mcpActivities.length > 4 ||
        !value.mcpActivities.every(isMcpActivity))) ||
    (Object.hasOwn(value, 'userInputRequest') &&
      !isUserInputRequest(value.userInputRequest)) ||
    (Object.hasOwn(value, 'planProposal') &&
      (!isRecord(value.planProposal) ||
        !isId(value.planProposal.id) ||
        typeof value.planProposal.content !== 'string' ||
        value.planProposal.content.trim().length === 0 ||
        new TextEncoder().encode(value.planProposal.content).byteLength >
          64 * 1024)) ||
    (Object.hasOwn(value, 'usage') && !isTokenUsage(value.usage))
  ) {
    return false;
  }

  if (
    value.status !== 'inProgress' &&
    (value.messages.some((message) => message.status !== 'completed') ||
      (Array.isArray(pendingAgentOutputs) ? pendingAgentOutputs.length : 0) > 0 ||
      Object.hasOwn(value, 'userInputRequest'))
  ) {
    return false;
  }

  const workspaceRead = value.workspaceRead as
    ConversationWorkspaceReadActivity | undefined;
  if (
    value.status !== 'inProgress' &&
    workspaceRead &&
    (workspaceRead.callStatus !== 'completed' ||
      (workspaceRead.result && workspaceRead.result.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        workspaceRead.result?.status !== 'completed'))
  ) {
    return false;
  }

  const workspaceList = value.workspaceList as
    ConversationWorkspaceListActivity | undefined;
  if (
    value.status !== 'inProgress' &&
    workspaceList &&
    (workspaceList.callStatus !== 'completed' ||
      (workspaceList.result && workspaceList.result.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        workspaceList.result?.status !== 'completed'))
  ) {
    return false;
  }

  const workspaceSearch = value.workspaceSearch as
    ConversationWorkspaceSearchActivity | undefined;
  if (
    value.status !== 'inProgress' &&
    workspaceSearch &&
    (workspaceSearch.callStatus !== 'completed' ||
      (workspaceSearch.result &&
        workspaceSearch.result.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        workspaceSearch.result?.status !== 'completed'))
  ) {
    return false;
  }

  const fileChange = value.fileChange as
    ConversationFileChangeActivity | undefined;
  if (
    value.status !== 'inProgress' &&
    fileChange &&
    (fileChange.callStatus !== 'completed' ||
      (fileChange.change && fileChange.change.status !== 'completed') ||
      (fileChange.result && fileChange.result.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        fileChange.result?.status !== 'completed'))
  ) {
    return false;
  }

  const commandApproval = value.commandApproval as
    ConversationCommandApprovalActivity | undefined;
  if (
    value.status !== 'inProgress' &&
    commandApproval &&
    (commandApproval.requestStatus !== 'completed' ||
      (commandApproval.decision &&
        commandApproval.decision.status !== 'completed') ||
      (commandApproval.executionAttempt &&
        commandApproval.executionAttempt.status !== 'completed') ||
      (commandApproval.executionResult &&
        commandApproval.executionResult.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        (commandApproval.decision?.status !== 'completed' ||
          (commandApproval.executionAttempt &&
            commandApproval.executionResult?.status !== 'completed'))))
  ) {
    return false;
  }

  const mcpActivities = value.mcpActivities as
    readonly ConversationMcpActivity[] | undefined;
  if (
    value.status !== 'inProgress' &&
    mcpActivities?.some(
      (activity) =>
        activity.callStatus !== 'completed' ||
        activity.requestStatus !== 'completed' ||
        (activity.decision && activity.decision.status !== 'completed') ||
        (activity.executionAttempt &&
          activity.executionAttempt.status !== 'completed') ||
        (activity.result && activity.result.status !== 'completed') ||
        (value.status !== 'interrupted' &&
          (!activity.decision || !activity.result)),
    )
  ) {
    return false;
  }

  const hasError = Object.hasOwn(value, 'error');
  if (value.status === 'failed') {
    return hasError && isTurnError(value.error);
  }
  if (value.status === 'interrupted') {
    return !hasError || isTurnError(value.error);
  }
  return !hasError;
};

const isNotice = (value: unknown): value is ConversationNotice =>
  isRecord(value) &&
  (value.kind === 'requestFailed' ||
    value.kind === 'connectionLost' ||
    value.kind === 'warning') &&
  typeof value.summary === 'string' &&
  value.summary.length > 0;

const isThreadNavigator = (
  value: unknown,
): value is ConversationThreadNavigatorSnapshot => {
  const pendingMutation =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>).pendingMutation
      : undefined;
  if (
    !isRecord(value) ||
    !['loading', 'ready', 'error', 'unavailable'].includes(
      value.status as string,
    ) ||
    !Array.isArray(value.activeThreadIds) ||
    !value.activeThreadIds.every(isId) ||
    new Set(value.activeThreadIds).size !== value.activeThreadIds.length ||
    !isThreadTitleMap(value.activeThreadTitles, value.activeThreadIds) ||
    typeof value.activeTruncated !== 'boolean' ||
    (Object.hasOwn(value, 'runningThreadIds') &&
      (!Array.isArray(value.runningThreadIds) ||
        !value.runningThreadIds.every(isId))) ||
    (Object.hasOwn(value, 'inputRequiredThreadIds') &&
      (!Array.isArray(value.inputRequiredThreadIds) ||
        !value.inputRequiredThreadIds.every(isId))) ||
    (Object.hasOwn(value, 'unreadThreadStatuses') &&
      (!isRecord(value.unreadThreadStatuses) ||
        !Object.entries(value.unreadThreadStatuses).every(
          ([threadId, status]) =>
            isId(threadId) &&
            TERMINAL_TURN_STATUSES.has(
              status as ConversationTerminalTurnStatus,
            ),
        ))) ||
    !isRecord(value.search) ||
    typeof value.search.query !== 'string' ||
    new TextEncoder().encode(value.search.query).byteLength >
      MAX_THREAD_SEARCH_BYTES ||
    !['idle', 'loading', 'ready', 'empty', 'error'].includes(
      value.search.status as string,
    ) ||
    !Array.isArray(value.search.threadIds) ||
    !value.search.threadIds.every(isId) ||
    new Set(value.search.threadIds).size !== value.search.threadIds.length ||
    !isThreadTitleMap(value.search.threadTitles, value.search.threadIds) ||
    typeof value.search.truncated !== 'boolean' ||
    (Object.hasOwn(value.search, 'summary') &&
      (typeof value.search.summary !== 'string' ||
        value.search.summary.length === 0)) ||
    (Object.hasOwn(value, 'pendingThreadId') && !isId(value.pendingThreadId)) ||
    (Object.hasOwn(value, 'pendingMutation') &&
      (!isRecord(pendingMutation) ||
        !['rename', 'delete'].includes(
          pendingMutation.kind as string,
        ) ||
        !isId(pendingMutation.threadId))) ||
    (Object.hasOwn(value, 'pendingThreadId') &&
      Object.hasOwn(value, 'pendingMutation')) ||
    (Object.hasOwn(value, 'selectionNotice') &&
      (typeof value.selectionNotice !== 'string' ||
        value.selectionNotice.length === 0)) ||
    (Object.hasOwn(value, 'mutationNotice') &&
      (typeof value.mutationNotice !== 'string' ||
        value.mutationNotice.length === 0))
  ) {
    return false;
  }
  return (
    (value.search.status === 'idle'
      ? value.search.query.length === 0 &&
        value.search.threadIds.length === 0 &&
        !value.search.truncated
      : value.search.query.trim().length > 0) &&
    (value.search.status === 'empty'
      ? value.search.threadIds.length === 0
      : true)
  );
};

const isThreadTitleMap = (
  value: unknown,
  threadIds: readonly unknown[],
): value is Readonly<Record<string, string>> => {
  if (!isRecord(value)) {
    return false;
  }
  const knownIds = new Set(threadIds);
  return Object.entries(value).every(
    ([threadId, title]) =>
      knownIds.has(threadId) &&
      typeof title === 'string' &&
      title.trim().length > 0 &&
      new TextEncoder().encode(title).byteLength <= 256,
  );
};

const hasValidActiveTurn = (
  phase: ConversationPhase,
  activeTurnId: unknown,
  turns: readonly ConversationTurn[],
  threadSelected: boolean,
): boolean => {
  const activeTurns = turns.filter((turn) => turn.status === 'inProgress');
  const phaseHasActiveTurn = phase === 'inProgress' || phase === 'stopping';
  if (phase === 'starting') {
    return activeTurns.length === 0
      ? activeTurnId === undefined
      : activeTurns.length === 1 &&
          activeTurnId === activeTurns[0]?.id &&
          threadSelected;
  }
  if (phaseHasActiveTurn) {
    return (
      activeTurns.length === 1 &&
      activeTurnId === activeTurns[0]?.id &&
      threadSelected
    );
  }
  if (phase === 'unavailable' && activeTurns.length === 1) {
    return activeTurnId === activeTurns[0]?.id && threadSelected;
  }
  return activeTurns.length === 0 && activeTurnId === undefined;
};

export const isConversationThreadProjectionSnapshot = (
  value: unknown,
): value is ConversationThreadProjectionSnapshot =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['revision', 'workspaceId', 'threadId', 'phase', 'activeTurnId', 'turns', 'queue'].includes(
      key,
    ),
  ) &&
  Number.isSafeInteger(value.revision) &&
  Number(value.revision) >= 0 &&
  isId(value.workspaceId) &&
  isId(value.threadId) &&
  ['starting', 'inProgress', 'stopping', 'ready'].includes(
    String(value.phase),
  ) &&
  (!Object.hasOwn(value, 'activeTurnId') || isId(value.activeTurnId)) &&
  Array.isArray(value.turns) &&
  value.turns.every(isTurn) &&
  (value.queue === undefined || isThreadQueue(value.queue)) &&
  hasValidActiveTurn(
    value.phase as ConversationPhase,
    value.activeTurnId,
    value.turns,
    true,
  );

export const isConversationThreadProjectionDelta = (
  value: unknown,
): value is ConversationThreadProjectionDelta =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['revision', 'workspaceId', 'threadId', 'phase', 'activeTurnId', 'turn'].includes(
      key,
    ),
  ) &&
  Number.isSafeInteger(value.revision) &&
  Number(value.revision) >= 1 &&
  isId(value.workspaceId) &&
  isId(value.threadId) &&
  ['starting', 'inProgress', 'stopping', 'ready'].includes(
    String(value.phase),
  ) &&
  (!Object.hasOwn(value, 'activeTurnId') || isId(value.activeTurnId)) &&
  isTurn(value.turn) &&
  ((value.phase === 'inProgress' || value.phase === 'stopping')
    ? value.activeTurnId === value.turn.id && value.turn.status === 'inProgress'
    : value.phase === 'starting'
      ? value.activeTurnId === undefined ||
        (value.activeTurnId === value.turn.id && value.turn.status === 'inProgress')
      : value.activeTurnId === undefined || value.activeTurnId !== value.turn.id);

export const isConversationStateSnapshot = (
  value: unknown,
): value is ConversationStateSnapshot => {
  if (
    !isRecord(value) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    (Object.hasOwn(value, 'workspaceId') && !isId(value.workspaceId)) ||
    typeof value.phase !== 'string' ||
    !PHASES.has(value.phase as ConversationPhase) ||
    !Array.isArray(value.turns) ||
    !value.turns.every(isTurn) ||
    (value.queue !== undefined && !isThreadQueue(value.queue)) ||
    !isThreadNavigator(value.navigator) ||
    (Object.hasOwn(value, 'threadId') && !isId(value.threadId)) ||
    (Object.hasOwn(value, 'activeTurnId') && !isId(value.activeTurnId)) ||
    (Object.hasOwn(value, 'notice') && !isNotice(value.notice))
  ) {
    return false;
  }

  const activeTurnId = value.activeTurnId as string | undefined;
  return hasValidActiveTurn(
    value.phase as ConversationPhase,
    activeTurnId,
    value.turns,
    isId(value.threadId),
  );
};
